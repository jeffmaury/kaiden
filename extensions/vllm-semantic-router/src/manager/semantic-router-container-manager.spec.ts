/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import type { Stats } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ExtensionContext, Provider } from '@openkaiden/api';
import { net } from '@openkaiden/api';
import type { ContainerExtensionAPI } from '@openkaiden/container-extension-api';
import { Container } from 'inversify';
import { assert, beforeEach, describe, expect, test, vi } from 'vitest';
import { parse, stringify } from 'yaml';

import { EnvoyConfigSchema } from '/@/api/envoy-config-schema';
import { SemanticRouterLabel } from '/@/api/semantic-router-container-info';
import { SRConfigSchema } from '/@/api/sr-config-schema';
import { ContainerFinder } from '/@/helper/container-finder';
import { NetworkHelper } from '/@/helper/network-helper';
import { ContainerExtensionAPISymbol, ExtensionContextSymbol, VllmSemanticRouterProvider } from '/@/inject/symbol';

import { SemanticRouterContainerManager } from './semantic-router-container-manager';

vi.mock(import('@ai-sdk/openai-compatible'));
vi.mock(import('node:fs/promises'));
vi.mock(import('/@/helper/network-helper'));

const connectionDisposable = { dispose: vi.fn() };
const factoryDisposable = { dispose: vi.fn() };
const endpointsSubscription = { dispose: vi.fn() };

const routerStartMock = vi.fn();
const routerStopMock = vi.fn();
const routerRemoveMock = vi.fn();

const envoyStartMock = vi.fn();
const envoyStopMock = vi.fn();
const envoyRemoveMock = vi.fn();

const routerContainerMock = {
  id: 'router-container-id',
  start: routerStartMock,
  stop: routerStopMock,
  remove: routerRemoveMock,
};

const envoyContainerMock = {
  id: 'envoy-container-id',
  start: envoyStartMock,
  stop: envoyStopMock,
  remove: envoyRemoveMock,
};

const followProgressMock = vi.fn();
const imageInspectMock = vi.fn();

const dockerodeMock = {
  pull: vi.fn(),
  modem: { followProgress: followProgressMock },
  createContainer: vi.fn(),
  getImage: vi.fn(),
  listContainers: vi.fn(),
  getContainer: vi.fn(),
};

const providerMock: Provider = {
  setSemanticRouterConnectionFactory: vi.fn(),
  registerInferenceProviderConnection: vi.fn(),
} as unknown as Provider;

const containerExtensionAPIMock: ContainerExtensionAPI = {
  getEndpoints: vi.fn().mockReturnValue([{ path: '/var/run/docker.sock', dockerode: dockerodeMock }]),
  onEndpointsChanged: vi.fn(),
} as unknown as ContainerExtensionAPI;

const STORAGE_PATH = path.join(path.sep, 'tmp', 'test-storage');
const extensionContextMock: ExtensionContext = {
  storagePath: STORAGE_PATH,
} as unknown as ExtensionContext;

const defaultConfig = {
  version: 'v0.3',
  listeners: [{ name: 'http-8080', address: '0.0.0.0', port: 8080 }],
  providers: {
    models: [
      {
        name: 'gpt-4',
        provider_model_id: 'gpt-4',
        backend_refs: [{ name: 'primary', endpoint: 'localhost:8000', protocol: 'http', weight: 100 }],
      },
    ],
  },
  routing: {
    signals: { keywords: [] },
    modelCards: [{ name: 'gpt-4', modality: 'text', capabilities: ['chat'] }],
    decisions: [],
  },
  global: {
    services: { router_replay: { enabled: true, store_backend: 'memory' } },
  },
};

describe('SemanticRouterContainerManager', () => {
  let manager: SemanticRouterContainerManager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();

    vi.mocked(providerMock.setSemanticRouterConnectionFactory).mockReturnValue(factoryDisposable);
    vi.mocked(providerMock.registerInferenceProviderConnection).mockReturnValue(connectionDisposable);
    vi.mocked(containerExtensionAPIMock.getEndpoints).mockReturnValue([
      { path: '/var/run/docker.sock', dockerode: dockerodeMock } as never,
    ]);
    vi.mocked(containerExtensionAPIMock.onEndpointsChanged).mockReturnValue(endpointsSubscription);
    dockerodeMock.pull.mockResolvedValue('stream');
    followProgressMock.mockImplementation((_stream: unknown, onFinish: (err: Error | null) => void) => {
      onFinish(null);
    });
    dockerodeMock.listContainers.mockResolvedValue([]);
    dockerodeMock.getImage.mockReturnValue({ inspect: imageInspectMock });
    imageInspectMock.mockRejectedValue(Object.assign(new Error('no such image'), { statusCode: 404 }));
    dockerodeMock.createContainer.mockResolvedValueOnce(routerContainerMock).mockResolvedValueOnce(envoyContainerMock);
    dockerodeMock.getContainer.mockImplementation((id: string) => {
      if (id === routerContainerMock.id) return routerContainerMock;
      if (id === envoyContainerMock.id) return envoyContainerMock;
      return routerContainerMock;
    });
    routerStartMock.mockResolvedValue(undefined);
    routerStopMock.mockResolvedValue(undefined);
    routerRemoveMock.mockResolvedValue(undefined);
    envoyStartMock.mockResolvedValue(undefined);
    envoyStopMock.mockResolvedValue(undefined);
    envoyRemoveMock.mockResolvedValue(undefined);
    vi.mocked(net.getFreePort).mockResolvedValue(50001);
    vi.mocked(NetworkHelper.prototype.convertHost).mockReturnValue('converted-host');

    const container = new Container();
    container.bind(SemanticRouterContainerManager).toSelf();
    container.bind(ContainerFinder).toSelf();
    container.bind(NetworkHelper).toSelf();
    container.bind(VllmSemanticRouterProvider).toConstantValue(providerMock);
    container.bind(ContainerExtensionAPISymbol).toConstantValue(containerExtensionAPIMock);
    container.bind(ExtensionContextSymbol).toConstantValue(extensionContextMock);
    manager = await container.getAsync(SemanticRouterContainerManager);
  });

  test('init registers semantic router factory', async () => {
    await manager.init();

    expect(providerMock.setSemanticRouterConnectionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vllm' }),
    );
  });

  test('init does not register the factory when no endpoint is available', async () => {
    vi.mocked(containerExtensionAPIMock.getEndpoints).mockReturnValue([]);

    await manager.init();

    expect(containerExtensionAPIMock.onEndpointsChanged).toHaveBeenCalled();
    expect(providerMock.setSemanticRouterConnectionFactory).not.toHaveBeenCalled();
  });

  test('registers the factory when endpoints appear', async () => {
    vi.mocked(containerExtensionAPIMock.getEndpoints).mockReturnValue([]);
    await manager.init();
    const listener = vi.mocked(containerExtensionAPIMock.onEndpointsChanged).mock.calls[0]?.[0];
    assert(listener);

    listener([{ path: '/var/run/docker.sock', dockerode: dockerodeMock } as never]);

    expect(providerMock.setSemanticRouterConnectionFactory).toHaveBeenCalledOnce();
    expect(providerMock.setSemanticRouterConnectionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vllm' }),
    );
  });

  test('does not register the factory twice when endpoints change but remain available', async () => {
    await manager.init();
    const listener = vi.mocked(containerExtensionAPIMock.onEndpointsChanged).mock.calls[0]?.[0];
    assert(listener);

    listener([{ path: '/var/run/other.sock', dockerode: dockerodeMock } as never]);

    expect(providerMock.setSemanticRouterConnectionFactory).toHaveBeenCalledOnce();
    expect(factoryDisposable.dispose).not.toHaveBeenCalled();
  });

  test('unregisters the factory when no endpoint remains and registers it again when one comes back', async () => {
    await manager.init();
    const listener = vi.mocked(containerExtensionAPIMock.onEndpointsChanged).mock.calls[0]?.[0];
    assert(listener);

    listener([]);

    expect(factoryDisposable.dispose).toHaveBeenCalledOnce();

    listener([{ path: '/var/run/docker.sock', dockerode: dockerodeMock } as never]);

    expect(providerMock.setSemanticRouterConnectionFactory).toHaveBeenCalledTimes(2);
  });

  describe('existing containers discovery', () => {
    const routerInspectMock = vi.fn();

    function existingContainers(state: string, name = 'existing'): unknown[] {
      return [
        {
          Id: 'existing-router',
          Labels: { [SemanticRouterLabel.NAME]: name, [SemanticRouterLabel.ROLE]: 'router' },
          State: state,
        },
        {
          Id: 'existing-envoy',
          Labels: { [SemanticRouterLabel.NAME]: name, [SemanticRouterLabel.ROLE]: 'envoy' },
          State: state,
        },
        { Id: 'unrelated', Labels: {}, State: 'running' },
      ];
    }

    beforeEach(() => {
      dockerodeMock.getContainer.mockImplementation((id: string) => {
        if (id === 'existing-router') return { ...routerContainerMock, inspect: routerInspectMock };
        return routerContainerMock;
      });
      routerInspectMock.mockResolvedValue({ HostConfig: { PortBindings: { '8801/tcp': [{ HostPort: '8888' }] } } });
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Stats);
    });

    test.each([
      ['running', 'started'],
      ['exited', 'stopped'],
    ])('init registers existing %s containers as a %s connection', async (state, status) => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers(state));

      await manager.init();

      expect(dockerodeMock.listContainers).toHaveBeenCalledWith({ all: true });
      expect(providerMock.registerInferenceProviderConnection).toHaveBeenCalledOnce();
      const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]?.[0];
      assert(registeredConnection);
      expect(registeredConnection.id).toBe('existing');
      expect(registeredConnection.name).toBe('existing');
      expect(registeredConnection.endpoint).toBe('http://localhost:8888/v1');
      expect(registeredConnection.status()).toBe(status);
    });

    test('init does not look for existing containers when no endpoint is available', async () => {
      vi.mocked(containerExtensionAPIMock.getEndpoints).mockReturnValue([]);

      await manager.init();

      expect(dockerodeMock.listContainers).not.toHaveBeenCalled();
    });

    test('registers existing containers when endpoints appear', async () => {
      vi.mocked(containerExtensionAPIMock.getEndpoints).mockReturnValue([]);
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running'));
      await manager.init();
      const listener = vi.mocked(containerExtensionAPIMock.onEndpointsChanged).mock.calls[0]?.[0];
      assert(listener);

      listener([{ path: '/var/run/docker.sock', dockerode: dockerodeMock } as never]);

      await vi.waitFor(() => expect(providerMock.registerInferenceProviderConnection).toHaveBeenCalledOnce());
    });

    test('does not register an existing connection twice when the factory is registered again', async () => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running'));
      await manager.init();
      const listener = vi.mocked(containerExtensionAPIMock.onEndpointsChanged).mock.calls[0]?.[0];
      assert(listener);

      listener([]);
      listener([{ path: '/var/run/docker.sock', dockerode: dockerodeMock } as never]);

      await vi.waitFor(() => expect(dockerodeMock.listContainers).toHaveBeenCalledTimes(2));
      expect(providerMock.registerInferenceProviderConnection).toHaveBeenCalledOnce();
    });

    // an unhandled rejection would fail the test run
    test('catches errors when registering the factory fails after endpoints change', async () => {
      vi.mocked(containerExtensionAPIMock.getEndpoints).mockReturnValue([]);
      await manager.init();
      const listener = vi.mocked(containerExtensionAPIMock.onEndpointsChanged).mock.calls[0]?.[0];
      assert(listener);
      vi.mocked(providerMock.setSemanticRouterConnectionFactory).mockImplementation(() => {
        throw new Error('registration failed');
      });

      listener([{ path: '/var/run/docker.sock', dockerode: dockerodeMock } as never]);

      await vi.waitFor(() => expect(providerMock.setSemanticRouterConnectionFactory).toHaveBeenCalledOnce());
      expect(dockerodeMock.listContainers).not.toHaveBeenCalled();
    });

    test.each(['../../..', 'nested/router', 'CON', ''])('skips a router with invalid name %j', async name => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running', name));

      await manager.init();

      expect(stat).not.toHaveBeenCalled();
      expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    });

    test('checks the config folder of the discovered router', async () => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running'));

      await manager.init();

      expect(stat).toHaveBeenCalledWith(path.join(STORAGE_PATH, 'configs', 'existing'));
    });

    test.each([
      ['is missing', Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })],
      ['cannot be read', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })],
    ])('skips a router whose config folder %s', async (_label, error) => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running'));
      vi.mocked(stat).mockRejectedValue(error);

      await manager.init();

      expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    });

    test('skips a router whose config path is not a folder', async () => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running'));
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as Stats);

      await manager.init();

      expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    });

    test('skips a router without envoy container', async () => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running').slice(0, 1));

      await manager.init();

      expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    });

    test.each([
      ['no port bindings', { HostConfig: {} }],
      [
        'only the gRPC port bound (created before envoy shared its network)',
        { HostConfig: { PortBindings: { '50051/tcp': [{ HostIp: '127.0.0.1', HostPort: '50001' }] } } },
      ],
      ['an invalid envoy host port', { HostConfig: { PortBindings: { '8801/tcp': [{ HostPort: '' }] } } }],
    ])('skips a router whose container has %s', async (_label, inspectResult) => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running'));
      routerInspectMock.mockResolvedValue(inspectResult);

      await manager.init();

      expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    });

    test('keeps the factory registered when listing containers fails', async () => {
      dockerodeMock.listContainers.mockRejectedValue(new Error('engine unavailable'));

      await manager.init();

      expect(providerMock.setSemanticRouterConnectionFactory).toHaveBeenCalledOnce();
      expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    });

    test('skips a router whose container cannot be inspected', async () => {
      dockerodeMock.listContainers.mockResolvedValue(existingContainers('running'));
      routerInspectMock.mockRejectedValue(new Error('inspect failed'));

      await expect(manager.init()).resolves.toBeUndefined();

      expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    });
  });

  test('create creates router and envoy containers in stopped state', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    expect(dockerodeMock.pull).toHaveBeenCalledWith('ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0');
    expect(dockerodeMock.pull).toHaveBeenCalledWith('docker.io/envoyproxy/envoy:v1.40.2');
    expect(dockerodeMock.createContainer).toHaveBeenCalledTimes(2);

    const routerCall = dockerodeMock.createContainer.mock.calls[0];
    assert(routerCall);
    expect(routerCall[0].Image).toBe('ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0');
    expect(routerCall[0].Labels[SemanticRouterLabel.NAME]).toBe('my-router');
    expect(routerCall[0].Labels[SemanticRouterLabel.ROLE]).toBe('router');
    expect(routerCall[0].HostConfig.PortBindings['50051/tcp']).toBeUndefined();
    expect(routerCall[0].ExposedPorts).toEqual({ '8801/tcp': {} });
    expect(routerCall[0].HostConfig.Mounts[0].Source).toBe(
      path.join(STORAGE_PATH, 'configs', 'my-router', 'config.yaml'),
    );
    expect(routerCall[0].HostConfig.Mounts[0].Target).toBe('/app/config.yaml');

    const envoyCall = dockerodeMock.createContainer.mock.calls[1];
    assert(envoyCall);
    expect(envoyCall[0].Image).toBe('docker.io/envoyproxy/envoy:v1.40.2');
    expect(envoyCall[0].User).toBe('101');
    expect(envoyCall[0].Cmd).toEqual(['envoy', '-c', '/etc/envoy/envoy.yaml', '-l', 'debug']);
    expect(envoyCall[0].Labels[SemanticRouterLabel.NAME]).toBe('my-router');
    expect(envoyCall[0].Labels[SemanticRouterLabel.ROLE]).toBe('envoy');
    expect(envoyCall[0].HostConfig.NetworkMode).toBe('container:router-container-id');
    expect(envoyCall[0].HostConfig.PortBindings).toBeUndefined();
    expect(envoyCall[0].ExposedPorts).toBeUndefined();
    expect(envoyCall[0].HostConfig.Mounts[0].Source).toBe(
      path.join(STORAGE_PATH, 'configs', 'my-router', 'envoy.yaml'),
    );
    expect(envoyCall[0].HostConfig.Mounts[0].Target).toBe('/etc/envoy/envoy.yaml');

    expect(routerStartMock).not.toHaveBeenCalled();
    expect(envoyStartMock).not.toHaveBeenCalled();

    const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]![0];
    expect(registeredConnection.name).toBe('my-router');
    expect(registeredConnection.type).toBe('local');
    expect(registeredConnection.status()).toBe('stopped');
    expect(registeredConnection.endpoint).toMatch(/^http:\/\/localhost:\d+\/v1$/);
  });

  test.each([
    { dev: true, level: 'debug', tracesExporter: 'console' },
    { dev: false, level: 'info', tracesExporter: 'none' },
  ])('create sets log level $level and traces exporter $tracesExporter when DEV is $dev', async ({
    dev,
    level,
    tracesExporter,
  }) => {
    vi.stubEnv('DEV', dev);
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    const routerCall = dockerodeMock.createContainer.mock.calls[0];
    assert(routerCall);
    expect(routerCall[0].Env).toContain(`SR_LOG_LEVEL=${level}`);
    expect(routerCall[0].Env).toContain(`OTEL_TRACES_EXPORTER=${tracesExporter}`);
    const envoyCall = dockerodeMock.createContainer.mock.calls[1];
    assert(envoyCall);
    expect(envoyCall[0].Cmd).toEqual(['envoy', '-c', '/etc/envoy/envoy.yaml', '-l', level]);
  });

  test('create publishes only the envoy port, on loopback, from the router container', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    expect(net.getFreePort).toHaveBeenCalledOnce();
    expect(net.getFreePort).toHaveBeenCalledWith(0);

    const routerCall = dockerodeMock.createContainer.mock.calls[0];
    assert(routerCall);
    expect(routerCall[0].HostConfig.PortBindings).toEqual({
      '8801/tcp': [{ HostIp: '127.0.0.1', HostPort: '50001' }],
    });

    const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]?.[0];
    assert(registeredConnection);
    expect(registeredConnection.endpoint).toBe('http://localhost:50001/v1');
  });

  test('create fails without creating containers when no free port is available', async () => {
    vi.mocked(net.getFreePort).mockRejectedValue(new Error('Unable to find a free port'));

    await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) })).rejects.toThrow(
      'Unable to find a free port',
    );
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
  });

  test('create generates envoy config with ExtProc and backend clusters from SR config', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    const envoyConfigCall = vi
      .mocked(writeFile)
      .mock.calls.find(c => (c[0] as string).endsWith(path.join(path.sep, 'envoy.yaml')));
    assert(envoyConfigCall);

    const envoyConfig = parse(envoyConfigCall[1] as string) as Record<string, unknown>;
    const clusters = (envoyConfig.static_resources as Record<string, unknown>).clusters as Array<
      Record<string, unknown>
    >;

    const extprocCluster = clusters.find(c => c.name === 'extproc_service');
    assert(extprocCluster);

    expect(extprocCluster.type).toBe('STATIC');

    const endpoints = (extprocCluster!.load_assignment as Record<string, unknown>).endpoints as Array<
      Record<string, unknown>
    >;
    assert(endpoints[0]);
    const lbEndpoints = endpoints[0].lb_endpoints as Array<Record<string, unknown>>;
    const socketAddress = ((lbEndpoints[0]!.endpoint as Record<string, unknown>).address as Record<string, unknown>)
      .socket_address as Record<string, unknown>;
    expect(socketAddress.address).toBe('127.0.0.1');
    expect(socketAddress.port_value).toBe(50051);

    const backendCluster = clusters.find(c => c.name === 'gpt-4');
    assert(backendCluster);
    const backendEndpoints = (backendCluster.load_assignment as Record<string, unknown>).endpoints as Array<
      Record<string, unknown>
    >;
    const backendLbEndpoints = backendEndpoints[0].lb_endpoints as Array<Record<string, unknown>>;
    const backendAddr = ((backendLbEndpoints[0].endpoint as Record<string, unknown>).address as Record<string, unknown>)
      .socket_address as Record<string, unknown>;
    expect(backendAddr.address).toBe('converted-host');
    expect(NetworkHelper.prototype.convertHost).toHaveBeenCalledWith('localhost');
    expect(backendAddr.port_value).toBe(8000);
  });

  test('create generates envoy config with one cluster per model', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    const multiBackendConfig = {
      ...defaultConfig,
      providers: {
        models: [
          {
            name: 'model-a',
            provider_model_id: 'model-a',
            backend_refs: [{ name: 'primary', endpoint: 'host-a:8000', protocol: 'http', weight: 100 }],
          },
          {
            name: 'model-b',
            provider_model_id: 'model-b',
            backend_refs: [{ name: 'primary', endpoint: 'host-b:9000', protocol: 'http', weight: 100 }],
          },
          {
            name: 'model-c',
            provider_model_id: 'model-c',
            backend_refs: [{ name: 'primary', endpoint: 'host-a:8000', protocol: 'http', weight: 100 }],
          },
        ],
      },
    };

    await manager.create({ name: 'my-router', config: stringify(multiBackendConfig) });

    const envoyConfigCall = vi
      .mocked(writeFile)
      .mock.calls.find(c => (c[0] as string).endsWith(path.join(path.sep, 'envoy.yaml')));
    assert(envoyConfigCall);
    const envoyConfig = parse(envoyConfigCall[1] as string) as Record<string, unknown>;
    const clusters = (envoyConfig.static_resources as Record<string, unknown>).clusters as Array<
      Record<string, unknown>
    >;

    const modelClusters = clusters.filter(c => c.name !== 'extproc_service');
    expect(modelClusters).toHaveLength(3);
    assert(modelClusters.find(c => c.name === 'model-a'));
    assert(modelClusters.find(c => c.name === 'model-b'));
    assert(modelClusters.find(c => c.name === 'model-c'));
  });

  test('create rejects duplicate model names without side effects', async () => {
    const duplicateConfig = {
      ...defaultConfig,
      providers: {
        models: [
          {
            name: 'model-a',
            provider_model_id: 'model-a',
            backend_refs: [{ name: 'primary', endpoint: 'host-a:8000', protocol: 'http', weight: 100 }],
          },
          {
            name: 'model-a',
            provider_model_id: 'model-a',
            backend_refs: [{ name: 'primary', endpoint: 'host-b:9000', protocol: 'http', weight: 100 }],
          },
        ],
      },
    };

    await expect(manager.create({ name: 'my-router', config: stringify(duplicateConfig) })).rejects.toThrow(
      "Invalid semantic router configuration: model 'model-a' is defined more than once",
    );
    expect(mkdir).not.toHaveBeenCalled();
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
  });

  test('create defaults backend port to 80 when endpoint has no port', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    const noPortConfig = {
      ...defaultConfig,
      providers: {
        models: [
          {
            name: 'model-a',
            provider_model_id: 'model-a',
            backend_refs: [{ name: 'primary', endpoint: 'my-backend', protocol: 'http', weight: 100 }],
          },
        ],
      },
    };

    await manager.create({ name: 'my-router', config: stringify(noPortConfig) });

    const envoyConfigCall = vi
      .mocked(writeFile)
      .mock.calls.find(c => (c[0] as string).endsWith(path.join(path.sep, 'envoy.yaml')));
    assert(envoyConfigCall);
    const envoyConfig = parse(envoyConfigCall[1] as string) as Record<string, unknown>;
    const clusters = (envoyConfig.static_resources as Record<string, unknown>).clusters as Array<
      Record<string, unknown>
    >;

    const backendCluster = clusters.find(c => c.name === 'model-a');
    assert(backendCluster);
    const addr = (
      (
        ((backendCluster.load_assignment as Record<string, unknown>).endpoints as Array<Record<string, unknown>>)[0]!
          .lb_endpoints as Array<Record<string, unknown>>
      )[0].endpoint as Record<string, unknown>
    ).address as Record<string, unknown>;
    const socketAddress = addr.socket_address as Record<string, unknown>;
    expect(socketAddress.address).toBe('converted-host');
    expect(NetworkHelper.prototype.convertHost).toHaveBeenCalledWith('my-backend');
    expect(socketAddress.port_value).toBe(80);
  });

  function configWithEndpoint(endpoint: string, protocol = 'http'): string {
    return stringify({
      ...defaultConfig,
      providers: {
        models: [
          {
            name: 'model-a',
            provider_model_id: 'model-a',
            backend_refs: [{ name: 'primary', endpoint, protocol, weight: 100 }],
          },
        ],
      },
    });
  }

  test.each([
    ['host:8000/v1', 'http', 'host', 8000],
    ['localhost/v1', 'http', 'localhost', 80],
    ['api.example.com', 'https', 'api.example.com', 443],
    ['[::1]:8000', 'http', '::1', 8000],
    ['[2001:db8::1]', 'https', '2001:db8::1', 443],
  ])('create parses backend endpoint %j (%s)', async (endpoint, protocol, hostname, port) => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: configWithEndpoint(endpoint, protocol) });

    expect(NetworkHelper.prototype.convertHost).toHaveBeenCalledWith(hostname);
    const envoyConfigCall = vi
      .mocked(writeFile)
      .mock.calls.find(c => (c[0] as string).endsWith(path.join(path.sep, 'envoy.yaml')));
    assert(envoyConfigCall);
    const envoyConfig = EnvoyConfigSchema.parse(parse(envoyConfigCall[1] as string));
    const cluster = envoyConfig.static_resources.clusters.find(c => c.name === 'model-a');
    assert(cluster);
    expect(cluster.load_assignment.endpoints[0]?.lb_endpoints[0]?.endpoint.address.socket_address.port_value).toBe(
      port,
    );
  });

  test.each([
    ['no backend_refs entry', [], 0],
    [
      'several backend_refs entries',
      [
        { name: 'primary', endpoint: 'host-a:8000', protocol: 'http', weight: 80 },
        { name: 'secondary', endpoint: 'host-b:8000', protocol: 'http', weight: 20 },
      ],
      2,
    ],
  ])('create rejects a model with %s without side effects', async (_label, backendRefs, count) => {
    const config = stringify({
      ...defaultConfig,
      providers: { models: [{ name: 'model-a', provider_model_id: 'model-a', backend_refs: backendRefs }] },
    });

    await expect(manager.create({ name: 'my-router', config })).rejects.toThrow(
      `model 'model-a' must have exactly one backend_refs entry, found ${count}`,
    );
    expect(mkdir).not.toHaveBeenCalled();
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
  });

  test.each([
    ['host:notaport', 'expected host[:port]'],
    ['host:70000', 'expected host[:port]'],
    ['::1:8000', 'expected host[:port]'],
    ['http://host:8000', 'the endpoint must not include a scheme'],
    [':8000', 'expected host[:port]'],
  ])('create rejects backend endpoint %j without side effects', async (endpoint, reason) => {
    await expect(manager.create({ name: 'my-router', config: configWithEndpoint(endpoint) })).rejects.toThrow(
      `model 'model-a' has invalid endpoint '${endpoint}': ${reason}`,
    );

    expect(mkdir).not.toHaveBeenCalled();
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
  });

  test('generated envoy config passes schema validation', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    const envoyConfigCall = vi
      .mocked(writeFile)
      .mock.calls.find(c => (c[0] as string).endsWith(path.join(path.sep, 'envoy.yaml')));
    assert(envoyConfigCall);
    const roundtripped = parse(envoyConfigCall[1] as string) as unknown;
    expect(() => EnvoyConfigSchema.parse(roundtripped)).not.toThrow();
  });

  test('SR config passes schema validation', () => {
    expect(() => SRConfigSchema.parse(defaultConfig)).not.toThrow();
  });

  test('create throws when no container engine is available', async () => {
    vi.mocked(containerExtensionAPIMock.getEndpoints).mockReturnValue([]);

    await expect(manager.create({ name: 'no-engine', config: stringify(defaultConfig) })).rejects.toThrow(
      'No container engine available',
    );
  });

  test.each([
    ['', 'name must not be empty'],
    ['   ', 'name must not be empty'],
    ['a'.repeat(256), 'name must not exceed 255 characters'],
    ['..', 'name must not end with a dot or a space'],
    ['.', 'name must not end with a dot or a space'],
    ['my-router.', 'name must not end with a dot or a space'],
    ['my-router ', 'name must not end with a dot or a space'],
    ['../escape', 'control characters'],
    ['nested/router', 'control characters'],
    ['back\\slash', 'control characters'],
    ['a:b', 'control characters'],
    ['what?', 'control characters'],
    ['star*', 'control characters'],
    ['tab\there', 'control characters'],
    ['CON', 'name is a reserved system name'],
    ['nul.txt', 'name is a reserved system name'],
    ['com1', 'name is a reserved system name'],
  ])('create rejects invalid name %j', async (name, reason) => {
    await expect(manager.create({ name, config: stringify(defaultConfig) })).rejects.toThrow(reason);

    expect(containerExtensionAPIMock.getEndpoints).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
  });

  test.each([
    'my-router',
    'My Router_2',
    'router.v1',
    'console',
    'com10',
  ])('create accepts valid name %j', async name => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await expect(manager.create({ name, config: stringify(defaultConfig) })).resolves.toEqual({ connectionId: name });
  });

  test('create uses the name as connection id and creates its config folder', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    const result = await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    expect(result).toEqual({ connectionId: 'my-router' });
    expect(mkdir).toHaveBeenCalledWith(path.join(STORAGE_PATH, 'configs'), { recursive: true });
    expect(mkdir).toHaveBeenCalledWith(path.join(STORAGE_PATH, 'configs', 'my-router'));
    const routerCall = dockerodeMock.createContainer.mock.calls[0];
    assert(routerCall);
    const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]?.[0];
    assert(registeredConnection);
    expect(registeredConnection.id).toBe('my-router');
  });

  test('create rejects when the config folder already exists', async () => {
    vi.mocked(mkdir)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }));

    await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) })).rejects.toThrow(
      "A semantic router named 'my-router' already exists",
    );
    expect(writeFile).not.toHaveBeenCalled();
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  test('create propagates other errors when creating the config folder', async () => {
    vi.mocked(mkdir)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) })).rejects.toThrow(
      'EACCES: permission denied',
    );
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  test.each([
    ['invalid YAML', 'providers: [unclosed', 'Invalid semantic router configuration'],
    ['a config missing required fields', stringify({ version: 'v0.3' }), 'Invalid semantic router configuration'],
    ['a config with wrong field types', stringify({ ...defaultConfig, listeners: 'nope' }), 'listeners'],
  ])('create rejects %s without side effects', async (_label, config, message) => {
    await expect(manager.create({ name: 'my-router', config })).rejects.toThrow(message);

    expect(containerExtensionAPIMock.getEndpoints).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(dockerodeMock.pull).not.toHaveBeenCalled();
    expect(dockerodeMock.createContainer).not.toHaveBeenCalled();
  });

  describe('images', () => {
    const loggerMock = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

    beforeEach(() => {
      vi.mocked(createOpenAICompatible).mockReturnValue({} as unknown as OpenAICompatibleProvider);
    });

    test('create does not pull images that are already available', async () => {
      imageInspectMock.mockResolvedValue({});

      await manager.create({ name: 'my-router', config: stringify(defaultConfig) }, loggerMock);

      expect(dockerodeMock.getImage).toHaveBeenCalledWith('ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0');
      expect(dockerodeMock.getImage).toHaveBeenCalledWith('docker.io/envoyproxy/envoy:v1.40.2');
      expect(dockerodeMock.pull).not.toHaveBeenCalled();
      expect(loggerMock.log).toHaveBeenCalledWith(
        'Image ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0 is already available',
      );
    });

    test('create pulls only the missing image', async () => {
      imageInspectMock
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(Object.assign(new Error('no such image'), { statusCode: 404 }));

      await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

      expect(dockerodeMock.pull).toHaveBeenCalledOnce();
      expect(dockerodeMock.pull).toHaveBeenCalledWith('docker.io/envoyproxy/envoy:v1.40.2');
    });

    test('create still pulls the image when inspecting it fails for another reason', async () => {
      imageInspectMock.mockRejectedValue(new Error('engine error'));

      await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

      expect(dockerodeMock.pull).toHaveBeenCalledTimes(2);
    });

    test('create reports pull progress to the logger once per layer status', async () => {
      followProgressMock.mockImplementation(
        (
          _stream: unknown,
          onFinish: (err: Error | null) => void,
          onProgress: (event: { id?: string; status?: string }) => void,
        ) => {
          onProgress({ status: 'Pulling from vllm-project/semantic-router' });
          onProgress({ id: 'layer1', status: 'Downloading' });
          onProgress({ id: 'layer1', status: 'Downloading' });
          onProgress({ id: 'layer1', status: 'Pull complete' });
          onProgress({});
          onFinish(null);
        },
      );

      await manager.create({ name: 'my-router', config: stringify(defaultConfig) }, loggerMock);

      const logs = loggerMock.log.mock.calls.map(c => c[0]);
      expect(logs).toContain('Pulling image ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0...');
      expect(logs).toContain('Pulling from vllm-project/semantic-router');
      expect(logs).toContain('Image ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0 pulled');
      // logged once per image (router and envoy), not once per progress event
      expect(logs.filter(l => l === 'layer1: Downloading')).toHaveLength(2);
      expect(logs.filter(l => l === 'layer1: Pull complete')).toHaveLength(2);
    });

    test('create reports failures to the logger', async () => {
      dockerodeMock.pull.mockRejectedValue(new Error('offline'));

      await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) }, loggerMock)).rejects.toThrow(
        'offline',
      );

      expect(loggerMock.error).toHaveBeenCalledWith(
        "Failed to create semantic router 'my-router':",
        expect.objectContaining({ message: 'offline' }),
      );
    });

    test('factory create forwards the logger', async () => {
      imageInspectMock.mockResolvedValue({});
      await manager.init();
      const factory = vi.mocked(providerMock.setSemanticRouterConnectionFactory).mock.calls[0]?.[0];
      assert(factory);

      await factory.create({ name: 'my-router', config: stringify(defaultConfig) }, loggerMock);

      expect(loggerMock.log).toHaveBeenCalledWith(
        'Image ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0 is already available',
      );
    });
  });

  test('create removes the config folder when container creation fails', async () => {
    dockerodeMock.pull.mockRejectedValue(new Error('pull failed'));

    await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) })).rejects.toThrow(
      'pull failed',
    );
    expect(rm).toHaveBeenCalledWith(path.join(STORAGE_PATH, 'configs', 'my-router'), {
      recursive: true,
      force: true,
    });
    expect(providerMock.registerInferenceProviderConnection).not.toHaveBeenCalled();
    expect(routerRemoveMock).not.toHaveBeenCalled();
    expect(envoyRemoveMock).not.toHaveBeenCalled();
  });

  test('create removes the router container and config folder when envoy creation fails', async () => {
    dockerodeMock.createContainer.mockReset();
    dockerodeMock.createContainer
      .mockResolvedValueOnce(routerContainerMock)
      .mockRejectedValueOnce(new Error('envoy create failed'));

    await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) })).rejects.toThrow(
      'envoy create failed',
    );
    expect(routerRemoveMock).toHaveBeenCalledWith({ force: true });
    expect(envoyRemoveMock).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(path.join(STORAGE_PATH, 'configs', 'my-router'), {
      recursive: true,
      force: true,
    });
  });

  test('create removes both containers when registering the connection fails', async () => {
    vi.mocked(providerMock.registerInferenceProviderConnection).mockImplementation(() => {
      throw new Error('registration failed');
    });

    await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) })).rejects.toThrow(
      'registration failed',
    );
    expect(routerRemoveMock).toHaveBeenCalledWith({ force: true });
    expect(envoyRemoveMock).toHaveBeenCalledWith({ force: true });
    // envoy uses the router network namespace, so it must be removed first
    const [envoyRemoveOrder] = envoyRemoveMock.mock.invocationCallOrder;
    const [routerRemoveOrder] = routerRemoveMock.mock.invocationCallOrder;
    assert(envoyRemoveOrder !== undefined && routerRemoveOrder !== undefined);
    expect(envoyRemoveOrder).toBeLessThan(routerRemoveOrder);
  });

  test('create still removes the config folder and rethrows when a container cannot be removed', async () => {
    dockerodeMock.createContainer.mockReset();
    dockerodeMock.createContainer
      .mockResolvedValueOnce(routerContainerMock)
      .mockRejectedValueOnce(new Error('envoy create failed'));
    routerRemoveMock.mockRejectedValue(new Error('remove failed'));

    await expect(manager.create({ name: 'my-router', config: stringify(defaultConfig) })).rejects.toThrow(
      'envoy create failed',
    );
    expect(rm).toHaveBeenCalledWith(path.join(STORAGE_PATH, 'configs', 'my-router'), {
      recursive: true,
      force: true,
    });
  });

  test('lifecycle.start starts router then envoy and updates status', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]![0];
    expect(registeredConnection.status()).toBe('stopped');

    assert(registeredConnection.lifecycle);
    assert(registeredConnection.lifecycle.start);
    await registeredConnection.lifecycle.start({} as never, {} as never);

    expect(routerStartMock).toHaveBeenCalled();
    expect(envoyStartMock).toHaveBeenCalled();
    const routerStartOrder = routerStartMock.mock.invocationCallOrder[0];
    const envoyStartOrder = envoyStartMock.mock.invocationCallOrder[0];
    expect(routerStartOrder).toBeLessThan(envoyStartOrder);
    expect(registeredConnection.status()).toBe('started');
  });

  test('lifecycle.stop stops envoy then router and updates status', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'my-router', config: stringify(defaultConfig) });

    const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]![0];
    assert(registeredConnection.lifecycle);
    assert(registeredConnection.lifecycle.start);
    await registeredConnection.lifecycle.start({} as never, {} as never);
    expect(registeredConnection.status()).toBe('started');

    assert(registeredConnection.lifecycle.stop);
    await registeredConnection.lifecycle.stop({} as never, {} as never);

    expect(envoyStopMock).toHaveBeenCalled();
    expect(routerStopMock).toHaveBeenCalled();
    const envoyStopOrder = envoyStopMock.mock.invocationCallOrder[0];
    const routerStopOrder = routerStopMock.mock.invocationCallOrder[0];
    expect(envoyStopOrder).toBeLessThan(routerStopOrder);
    expect(registeredConnection.status()).toBe('stopped');
  });

  describe('lifecycle.stop failures', () => {
    async function createStartedConnection(): Promise<
      Parameters<typeof providerMock.registerInferenceProviderConnection>[0]
    > {
      vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);
      await manager.create({ name: 'my-router', config: stringify(defaultConfig) });
      const connection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]?.[0];
      assert(connection?.lifecycle?.start);
      await connection.lifecycle.start({} as never, {} as never);
      expect(connection.status()).toBe('started');
      return connection;
    }

    test.each([
      { failing: 'envoy', stopMock: envoyStopMock, otherStopMock: routerStopMock },
      { failing: 'router', stopMock: routerStopMock, otherStopMock: envoyStopMock },
    ])('stops the other container and marks the connection stopped when $failing fails', async ({
      stopMock,
      otherStopMock,
    }) => {
      const connection = await createStartedConnection();
      stopMock.mockRejectedValue(Object.assign(new Error('stop failed'), { statusCode: 500 }));
      assert(connection.lifecycle?.stop);

      const error = await connection.lifecycle.stop({} as never, {} as never).catch((err: unknown) => err);

      expect(otherStopMock).toHaveBeenCalled();
      expect(connection.status()).toBe('stopped');
      assert(error instanceof AggregateError);
      expect(error.message).toBe("Failed to stop semantic router 'my-router'");
      expect(error.errors).toEqual([expect.objectContaining({ message: 'stop failed' })]);
    });

    test('reports both errors when both containers fail to stop', async () => {
      const connection = await createStartedConnection();
      envoyStopMock.mockRejectedValue(new Error('envoy stop failed'));
      routerStopMock.mockRejectedValue(new Error('router stop failed'));
      assert(connection.lifecycle?.stop);

      const error = await connection.lifecycle.stop({} as never, {} as never).catch((err: unknown) => err);

      expect(connection.status()).toBe('stopped');
      assert(error instanceof AggregateError);
      expect(error.errors).toHaveLength(2);
    });

    test('treats an already stopped container as stopped', async () => {
      const connection = await createStartedConnection();
      envoyStopMock.mockRejectedValue(Object.assign(new Error('container already stopped'), { statusCode: 304 }));
      assert(connection.lifecycle?.stop);

      await expect(connection.lifecycle.stop({} as never, {} as never)).resolves.toBeUndefined();

      expect(routerStopMock).toHaveBeenCalled();
      expect(connection.status()).toBe('stopped');
    });
  });

  test('lifecycle.delete stops and removes both containers', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);

    await manager.create({ name: 'delete-me', config: stringify({ ...defaultConfig, name: 'delete-me' }) });

    const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]![0];
    assert(registeredConnection.lifecycle);
    assert(registeredConnection.lifecycle.delete);
    await registeredConnection.lifecycle.delete();

    expect(routerStopMock).toHaveBeenCalled();
    expect(routerRemoveMock).toHaveBeenCalled();
    expect(envoyStopMock).toHaveBeenCalled();
    expect(envoyRemoveMock).toHaveBeenCalled();
    expect(connectionDisposable.dispose).toHaveBeenCalled();
  });

  test('lifecycle.delete unregisters the connection even when the config folder cannot be removed', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValueOnce({} as unknown as OpenAICompatibleProvider);
    await manager.create({ name: 'delete-me', config: stringify({ ...defaultConfig, name: 'delete-me' }) });
    const registeredConnection = vi.mocked(providerMock.registerInferenceProviderConnection).mock.calls[0]?.[0];
    assert(registeredConnection?.lifecycle?.delete);
    vi.mocked(rm).mockRejectedValue(new Error('EBUSY: resource busy'));

    await expect(registeredConnection.lifecycle.delete()).rejects.toThrow('EBUSY: resource busy');

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    // the connection is no longer tracked, so dispose() does not dispose it again
    manager.dispose();
    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
  });

  test('dispose cleans up factory and all connection registrations', async () => {
    vi.mocked(createOpenAICompatible).mockReturnValue({} as unknown as OpenAICompatibleProvider);

    await manager.init();
    await manager.create({ name: 'dispose-router', config: stringify({ ...defaultConfig, name: 'dispose-router' }) });

    manager.dispose();

    expect(factoryDisposable.dispose).toHaveBeenCalled();
    expect(connectionDisposable.dispose).toHaveBeenCalled();
    expect(endpointsSubscription.dispose).toHaveBeenCalled();
  });
});
