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

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  Disposable,
  ExtensionContext,
  Logger,
  Provider,
  SemanticRouter,
  SemanticRouterCreateParams,
} from '@openkaiden/api';
import { net } from '@openkaiden/api';
import type { ContainerExtensionAPI, EndpointConnection } from '@openkaiden/container-extension-api';
import type Dockerode from 'dockerode';
import { inject, injectable } from 'inversify';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { EnvoyCluster, type EnvoyConfig, EnvoyRoute, EnvoyRouteCluster } from '/@/api/envoy-config-schema';
import { SemanticRouterLabel, SemanticRouterRole } from '/@/api/semantic-router-container-info';
import { SRBackendRef, type SRConfig, SRConfigSchema, SRModel } from '/@/api/sr-config-schema';
import { ContainerFinder } from '/@/helper/container-finder';
import { NetworkHelper } from '/@/helper/network-helper';
import { ContainerExtensionAPISymbol, ExtensionContextSymbol, VllmSemanticRouterProvider } from '/@/inject/symbol';

interface ManagedConnection {
  routerContainerId: string;
  envoyContainerId: string;
  dockerode: Dockerode;
  disposable: Disposable;
  port: number;
  running: boolean;
}

type ModelInfo = { cluster: EnvoyCluster; route: EnvoyRoute };

@injectable()
export class SemanticRouterContainerManager {
  private static readonly VLLM_SR_IMAGE = 'ghcr.io/vllm-project/semantic-router/vllm-sr:v0.3.0';
  private static readonly ENVOY_IMAGE = 'docker.io/envoyproxy/envoy:v1.40.2';
  private static readonly ROUTER_GRPC_PORT = 50051;
  private static readonly ENVOY_LISTEN_PORT = 8801;
  private static readonly CONFIGS_FOLDER = 'configs';
  private static readonly ROUTER_CONFIG_FILE = 'config.yaml';
  private static readonly ENVOY_CONFIG_FILE = 'envoy.yaml';
  private static readonly ROUTER_CONFIG_CONTAINER_PATH = '/app/config.yaml';
  private static readonly ENVOY_CONFIG_CONTAINER_PATH = '/etc/envoy/envoy.yaml';

  @inject(VllmSemanticRouterProvider)
  private provider: Provider;

  @inject(ContainerExtensionAPISymbol)
  private containerExtensionAPI: ContainerExtensionAPI;

  @inject(ExtensionContextSymbol)
  private extensionContext: ExtensionContext;

  @inject(ContainerFinder)
  private containerFinder: ContainerFinder;

  @inject(NetworkHelper)
  private networkHelper: NetworkHelper;

  #connections: Map<string, ManagedConnection> = new Map();
  #factoryDisposable: Disposable | undefined;
  #endpointsSubscription: Disposable | undefined;

  async init(): Promise<void> {
    this.#endpointsSubscription = this.containerExtensionAPI.onEndpointsChanged(endpoints =>
      this.updateFactoryRegistration(endpoints).catch((err: unknown) =>
        console.error('vllm-semantic-router: failed to update semantic router factory registration', err),
      ),
    );
    await this.updateFactoryRegistration(this.containerExtensionAPI.getEndpoints());
  }

  /**
   * The name is used as a folder name for the router configuration, so it must be valid on all platforms.
   */
  private validateName(name: string): void {
    const invalid = (reason: string): Error => new Error(`Invalid semantic router name '${name}': ${reason}`);
    if (name.trim().length === 0) {
      throw invalid('name must not be empty');
    }
    if (name.length > 255) {
      throw invalid('name must not exceed 255 characters');
    }
    if (/[<>:"/\\|?*]/.test(name) || [...name].some(c => c.charCodeAt(0) < 0x20)) {
      throw invalid('name must not contain any of < > : " / \\ | ? * or control characters');
    }
    // also rejects '.' and '..'
    if (/[. ]$/.test(name)) {
      throw invalid('name must not end with a dot or a space');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
      throw invalid('name is a reserved system name');
    }
  }

  private parseConfig(config: string): SRConfig {
    let raw: unknown;
    try {
      raw = parse(config);
    } catch (err: unknown) {
      throw new Error(`Invalid semantic router configuration: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    const result = SRConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid semantic router configuration: ${z.prettifyError(result.error)}`, {
        cause: result.error,
      });
    }
    const modelNames = new Set<string>();
    for (const model of result.data.providers.models) {
      // the model name is the envoy cluster name and the routing key
      if (modelNames.has(model.name)) {
        throw new Error(`Invalid semantic router configuration: model '${model.name}' is defined more than once`);
      }
      modelNames.add(model.name);
      // envoy routes each model to a single backend
      if (model.backend_refs.length !== 1) {
        throw new Error(
          `Invalid semantic router configuration: model '${model.name}' must have exactly one backend_refs entry, found ${model.backend_refs.length}`,
        );
      }
      for (const ref of model.backend_refs) {
        this.parseBackendEndpoint(model, ref);
      }
    }
    return result.data;
  }

  /**
   * Parses a backend endpoint (`host[:port][/path]`, IPv6 hosts in brackets). The path is ignored.
   * The port defaults to 80 for http and 443 otherwise.
   */
  private parseBackendEndpoint(model: SRModel, ref: SRBackendRef): { hostname: string; port: number } {
    const invalid = (reason: string, cause?: unknown): Error =>
      new Error(
        `Invalid semantic router configuration: model '${model.name}' has invalid endpoint '${ref.endpoint}': ${reason}`,
        { cause },
      );
    if (ref.endpoint.includes('://')) {
      throw invalid('the endpoint must not include a scheme, use the protocol field instead');
    }
    let url: URL;
    try {
      url = new URL(`${ref.protocol}://${ref.endpoint}`);
    } catch (err: unknown) {
      throw invalid('expected host[:port] with a port between 0 and 65535 and IPv6 hosts in brackets', err);
    }
    const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (!hostname) {
      throw invalid('the host is missing');
    }
    const port = url.port ? Number(url.port) : ref.protocol === 'http' ? 80 : 443;
    return { hostname, port };
  }

  private async updateFactoryRegistration(endpoints: readonly EndpointConnection[]): Promise<void> {
    if (endpoints.length > 0 && !this.#factoryDisposable) {
      this.#factoryDisposable = this.provider.setSemanticRouterConnectionFactory({
        type: 'vllm',
        create: async (params: SemanticRouterCreateParams, logger?: Logger): Promise<SemanticRouter> => {
          return this.create(params, logger);
        },
      });
      await this.discoverExistingConnections(endpoints);
    } else if (endpoints.length === 0 && this.#factoryDisposable) {
      this.#factoryDisposable.dispose();
      this.#factoryDisposable = undefined;
    }
  }

  private async discoverExistingConnections(endpoints: readonly EndpointConnection[]): Promise<void> {
    for (const { dockerode } of endpoints) {
      let containers: Dockerode.ContainerInfo[];
      try {
        containers = await dockerode.listContainers({ all: true });
      } catch (err: unknown) {
        console.error('vllm-semantic-router: failed to list containers', err);
        continue;
      }

      const srContainers = this.containerFinder.findSemanticRouterContainers(containers);
      for (const router of srContainers.filter(c => c.Labels[SemanticRouterLabel.ROLE] === SemanticRouterRole.ROUTER)) {
        // labels come from any container on the engine: validate before using the name as a path
        const name = router.Labels[SemanticRouterLabel.NAME];
        try {
          this.validateName(name);
        } catch (err: unknown) {
          console.warn(`vllm-semantic-router: skipping container ${router.Id} with invalid name`, err);
          continue;
        }
        if (this.#connections.has(name)) {
          continue;
        }
        if (!(await this.isConfigFolderPresent(name))) {
          console.warn(`vllm-semantic-router: no config folder found for semantic router '${name}', skipping`);
          continue;
        }
        const envoy = this.containerFinder.findByNameAndRole(srContainers, name, SemanticRouterRole.ENVOY);
        if (!envoy) {
          console.warn(`vllm-semantic-router: no envoy container found for semantic router '${name}'`);
          continue;
        }
        try {
          const envoyHostPort = await this.getEnvoyHostPort(dockerode, router.Id);
          if (envoyHostPort === undefined) {
            console.warn(
              `vllm-semantic-router: no envoy host port bound on the router container of semantic router '${name}', recreate it`,
            );
            continue;
          }
          await this.registerInferenceConnection(
            name,
            name,
            envoyHostPort,
            dockerode,
            router.Id,
            envoy.Id,
            router.State === 'running' && envoy.State === 'running',
          );
        } catch (err: unknown) {
          console.error(`vllm-semantic-router: failed to register existing semantic router '${name}'`, err);
        }
      }
    }
  }

  // debug logs may contain prompt content: only enable them in development builds
  private getLogLevel(): 'debug' | 'info' {
    return import.meta.env.DEV ? 'debug' : 'info';
  }

  private getConfigsDir(): string {
    return join(this.extensionContext.storagePath, SemanticRouterContainerManager.CONFIGS_FOLDER);
  }

  private getRouterDir(name: string): string {
    return join(this.getConfigsDir(), name);
  }

  private async isConfigFolderPresent(name: string): Promise<boolean> {
    const routerDir = this.getRouterDir(name);
    try {
      return (await stat(routerDir)).isDirectory();
    } catch (err: unknown) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
        console.error(`vllm-semantic-router: failed to check config folder ${routerDir}`, err);
      }
      return false;
    }
  }

  // envoy shares the router network namespace, so its port is published on the router container.
  // Port bindings are only listed for running containers, so inspect to also support stopped ones
  private async getEnvoyHostPort(dockerode: Dockerode, routerContainerId: string): Promise<number | undefined> {
    const info = await dockerode.getContainer(routerContainerId).inspect();
    const hostPort = Number(
      info.HostConfig.PortBindings?.[`${SemanticRouterContainerManager.ENVOY_LISTEN_PORT}/tcp`]?.[0]?.HostPort,
    );
    return Number.isInteger(hostPort) && hostPort > 0 ? hostPort : undefined;
  }

  async create(params: SemanticRouterCreateParams, logger?: Logger): Promise<SemanticRouter> {
    this.validateName(params.name);
    const srConfig = this.parseConfig(params.config);

    const endpoints = this.containerExtensionAPI.getEndpoints();
    if (endpoints.length === 0) {
      throw new Error('No container engine available');
    }
    const dockerode = endpoints[0].dockerode;

    await mkdir(this.getConfigsDir(), { recursive: true });
    const routerDir = this.getRouterDir(params.name);
    try {
      await mkdir(routerDir);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
        throw new Error(`A semantic router named '${params.name}' already exists`);
      }
      throw err;
    }

    const createdContainers: Dockerode.Container[] = [];
    try {
      return await this.createContainers(params, srConfig, dockerode, routerDir, createdContainers, logger);
    } catch (err: unknown) {
      console.error(`vllm-semantic-router: failed to create semantic router '${params.name}'`, err);
      logger?.error(`Failed to create semantic router '${params.name}':`, err);
      // envoy uses the router network namespace: remove it first
      for (const container of createdContainers.toReversed()) {
        try {
          await container.remove({ force: true });
        } catch (removeErr: unknown) {
          console.error(`vllm-semantic-router: failed to remove container ${container.id}`, removeErr);
        }
      }
      await rm(routerDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async createContainers(
    params: SemanticRouterCreateParams,
    srConfig: SRConfig,
    dockerode: Dockerode,
    routerDir: string,
    createdContainers: Dockerode.Container[],
    logger?: Logger,
  ): Promise<SemanticRouter> {
    const connectionId = params.name;

    const configFilePath = join(routerDir, SemanticRouterContainerManager.ROUTER_CONFIG_FILE);
    await writeFile(configFilePath, params.config, 'utf-8');

    await this.ensureImage(dockerode, SemanticRouterContainerManager.VLLM_SR_IMAGE, logger);

    const envoyHostPort = await net.getFreePort(0);

    const routerContainer = await dockerode.createContainer({
      Image: SemanticRouterContainerManager.VLLM_SR_IMAGE,
      Labels: {
        [SemanticRouterLabel.NAME]: params.name,
        [SemanticRouterLabel.ROLE]: SemanticRouterRole.ROUTER,
      },
      // envoy joins this container network namespace: the router gRPC port stays private and
      // the envoy port is published here
      ExposedPorts: {
        [`${SemanticRouterContainerManager.ENVOY_LISTEN_PORT}/tcp`]: {},
      },
      Env: [
        `SR_LOG_LEVEL=${this.getLogLevel()}`,
        'SR_LOG_ENCODING=console',
        `OTEL_TRACES_EXPORTER=${import.meta.env.DEV ? 'console' : 'none'}`,
        'OTEL_SERVICE_NAME=semantic-router',
      ],
      HostConfig: {
        PortBindings: {
          [`${SemanticRouterContainerManager.ENVOY_LISTEN_PORT}/tcp`]: [
            { HostIp: '127.0.0.1', HostPort: String(envoyHostPort) },
          ],
        },
        Mounts: [
          {
            Source: configFilePath,
            Type: 'bind' as const,
            Target: SemanticRouterContainerManager.ROUTER_CONFIG_CONTAINER_PATH,
            ReadOnly: true,
          },
        ],
      },
    });
    createdContainers.push(routerContainer);

    const envoyConfigContent = this.generateEnvoyConfig(srConfig);
    const envoyConfigFilePath = join(routerDir, SemanticRouterContainerManager.ENVOY_CONFIG_FILE);
    await writeFile(envoyConfigFilePath, envoyConfigContent, 'utf-8');

    await this.ensureImage(dockerode, SemanticRouterContainerManager.ENVOY_IMAGE, logger);

    const envoyContainer = await dockerode.createContainer({
      Image: SemanticRouterContainerManager.ENVOY_IMAGE,
      User: '101',
      Cmd: ['envoy', '-c', SemanticRouterContainerManager.ENVOY_CONFIG_CONTAINER_PATH, '-l', this.getLogLevel()],
      Labels: {
        [SemanticRouterLabel.NAME]: params.name,
        [SemanticRouterLabel.ROLE]: SemanticRouterRole.ENVOY,
      },
      HostConfig: {
        NetworkMode: `container:${routerContainer.id}`,
        Mounts: [
          {
            Source: envoyConfigFilePath,
            Type: 'bind' as const,
            Target: SemanticRouterContainerManager.ENVOY_CONFIG_CONTAINER_PATH,
            ReadOnly: true,
          },
        ],
      },
    });
    createdContainers.push(envoyContainer);

    await this.registerInferenceConnection(
      params.name,
      connectionId,
      envoyHostPort,
      dockerode,
      routerContainer.id,
      envoyContainer.id,
      false,
    );

    return { connectionId };
  }

  private async registerInferenceConnection(
    name: string,
    connectionId: string,
    envoyHostPort: number,
    dockerode: Dockerode,
    routerContainerId: string,
    envoyContainerId: string,
    running: boolean,
  ): Promise<void> {
    const sdk = createOpenAICompatible({
      baseURL: `http://localhost:${envoyHostPort}/v1`,
      name: `vllm-sr/${name}`,
    });

    const managed: Omit<ManagedConnection, 'disposable'> = {
      routerContainerId,
      envoyContainerId,
      dockerode,
      port: envoyHostPort,
      running,
    };

    const disposable = this.provider.registerInferenceProviderConnection({
      id: connectionId,
      name: name,
      type: 'local',
      llmMetadata: { name: 'openai', semanticRouter: name },
      endpoint: `http://localhost:${envoyHostPort}/v1`,
      sdk,
      status() {
        return managed.running ? 'started' : 'stopped';
      },
      models: [
        {
          label: `Semantic Router ${name}`,
        },
      ],
      credentials() {
        return {};
      },
      lifecycle: {
        start: async (): Promise<void> => {
          await this.startContainers(dockerode, [routerContainerId, envoyContainerId], name, managed);
        },
        stop: async (): Promise<void> => {
          await this.stopContainers(dockerode, [envoyContainerId, routerContainerId], name, managed);
        },
        delete: async (): Promise<void> => {
          await this.deleteConnection(connectionId, dockerode, routerContainerId, envoyContainerId, name);
        },
      },
    });

    this.#connections.set(connectionId, { ...managed, disposable });
  }

  // 304 Not Modified: the container is already in the requested state
  private isNotModified(err: unknown): boolean {
    return err instanceof Error && 'statusCode' in err && err.statusCode === 304;
  }

  // containers are started in order; if one fails, the ones already running are stopped again so that the
  // connection is not left half started
  private async startContainers(
    dockerode: Dockerode,
    containerIds: string[],
    name: string,
    managed: Pick<ManagedConnection, 'running'>,
  ): Promise<void> {
    const running: string[] = [];
    for (const containerId of containerIds) {
      try {
        await dockerode.getContainer(containerId).start();
      } catch (err: unknown) {
        if (!this.isNotModified(err)) {
          console.error(`vllm-semantic-router: failed to start container ${containerId} for router ${name}`, err);
          try {
            await this.stopContainers(dockerode, running.toReversed(), name, managed);
          } catch (rollbackErr: unknown) {
            console.error(`vllm-semantic-router: failed to roll back start of router ${name}`, rollbackErr);
          }
          throw err;
        }
        // already started
      }
      running.push(containerId);
    }
    managed.running = true;
  }

  // a failure on one container must not prevent stopping the other one or marking the connection as stopped
  private async stopContainers(
    dockerode: Dockerode,
    containerIds: string[],
    name: string,
    managed: Pick<ManagedConnection, 'running'>,
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const containerId of containerIds) {
      try {
        await dockerode.getContainer(containerId).stop();
      } catch (err: unknown) {
        if (this.isNotModified(err)) {
          // already stopped
          continue;
        }
        console.error(`vllm-semantic-router: failed to stop container ${containerId} for router ${name}`, err);
        errors.push(err);
      }
    }
    managed.running = false;
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to stop semantic router '${name}'`);
    }
  }

  private async deleteConnection(
    connectionId: string,
    dockerode: Dockerode,
    routerContainerId: string,
    envoyContainerId: string,
    name: string,
  ): Promise<void> {
    for (const containerId of [envoyContainerId, routerContainerId]) {
      try {
        const container = dockerode.getContainer(containerId);
        try {
          await container.stop();
        } catch (err: unknown) {
          console.error(`vllm-semantic-router: failed to stop container ${containerId} for router ${name}`, err);
        }
        await container.remove();
      } catch (err: unknown) {
        console.error(`vllm-semantic-router: failed to remove container ${containerId} for router ${name}`, err);
      }
    }

    const routerDir = this.getRouterDir(name);
    try {
      await rm(routerDir, { recursive: true, force: true });
    } finally {
      // the containers are gone: always unregister the connection
      const managed = this.#connections.get(connectionId);
      managed?.disposable.dispose();
      this.#connections.delete(connectionId);
    }
  }

  private generateEnvoyConfig(srConfig: SRConfig): string {
    const models = this.extractModels(srConfig);

    const config: EnvoyConfig = {
      static_resources: {
        listeners: [
          {
            name: 'listener_0',
            address: {
              socket_address: { address: '0.0.0.0', port_value: SemanticRouterContainerManager.ENVOY_LISTEN_PORT },
            },
            filter_chains: [
              {
                filters: [
                  {
                    name: 'envoy.filters.network.http_connection_manager',
                    typed_config: {
                      '@type':
                        'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                      stat_prefix: 'ingress_http',
                      route_config: {
                        name: 'local_route',
                        virtual_hosts: [
                          {
                            name: 'local_service',
                            domains: ['*'],
                            request_headers_to_remove: [
                              'x-vsr-looper-request',
                              'x-vsr-looper-secret',
                              'x-vsr-looper-decision',
                              'x-vsr-looper-iteration',
                              'x-authz-user-id',
                              'x-authz-user-groups',
                            ],
                            routes: [
                              ...models.map(m => m.route),
                              { match: { prefix: '/' }, direct_response: { status: 503 } },
                            ],
                          },
                        ],
                      },
                      http_filters: [
                        {
                          name: 'envoy.filters.http.ext_proc',
                          typed_config: {
                            '@type': 'type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExternalProcessor',
                            grpc_service: {
                              envoy_grpc: { cluster_name: 'extproc_service' },
                            },
                            processing_mode: {
                              request_header_mode: 'SEND',
                              response_header_mode: 'SEND',
                              request_body_mode: 'BUFFERED',
                              response_body_mode: 'BUFFERED',
                            },
                            failure_mode_allow: false,
                            message_timeout: '300s',
                          },
                        },
                        {
                          name: 'envoy.filters.http.router',
                          typed_config: {
                            '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                          },
                        },
                      ],
                      stream_idle_timeout: '300s',
                      request_timeout: '300s',
                    },
                  },
                ],
              },
            ],
          },
        ],
        clusters: [
          {
            name: 'extproc_service',
            connect_timeout: '5s',
            type: 'STATIC',
            lb_policy: 'ROUND_ROBIN',
            http2_protocol_options: {},
            load_assignment: {
              cluster_name: 'extproc_service',
              endpoints: [
                {
                  lb_endpoints: [
                    {
                      endpoint: {
                        address: {
                          socket_address: {
                            // envoy shares the router network namespace
                            address: '127.0.0.1',
                            port_value: SemanticRouterContainerManager.ROUTER_GRPC_PORT,
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
          ...models.map(m => m.cluster),
        ],
      },
      admin: {
        address: {
          socket_address: { address: '0.0.0.0', port_value: 9901 },
        },
      },
    };

    return stringify(config);
  }

  private extractModels(srConfig: SRConfig): ModelInfo[] {
    // parseConfig already rejected duplicate model names
    return srConfig.providers.models.map(model => this.buildModelInfo(model));
  }

  private buildModelInfo(model: SRModel): ModelInfo {
    // parseConfig already ensured exactly one valid backend
    const ref = model.backend_refs[0];
    const { hostname, port } = this.parseBackendEndpoint(model, ref);
    const host = this.networkHelper.convertHost(hostname);
    const clusterName = model.name;

    const route: EnvoyRouteCluster = {
      cluster: clusterName,
      host_rewrite_literal: host,
    };
    const modelInfo: ModelInfo = {
      cluster: {
        name: clusterName,
        connect_timeout: '5s',
        type: 'LOGICAL_DNS',
        dns_lookup_family: 'V4_ONLY',
        lb_policy: 'ROUND_ROBIN',
        load_assignment: {
          cluster_name: clusterName,
          endpoints: [
            {
              lb_endpoints: [
                {
                  endpoint: {
                    address: {
                      socket_address: { address: host, port_value: port },
                    },
                    hostname: host,
                  },
                },
              ],
            },
          ],
        },
      },
      route: {
        match: {
          prefix: '/',
          headers: [
            {
              name: 'x-selected-model',
              string_match: {
                exact: clusterName,
              },
            },
          ],
        },
      },
    };
    modelInfo.route.route = route;
    if (ref.protocol === 'https') {
      modelInfo.cluster.transport_socket = {
        name: 'envoy.transport_sockets.tls',
        typed_config: {
          '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
          sni: host,
          common_tls_context: {
            tls_params: {
              tls_minimum_protocol_version: 'TLSv1_2',
              tls_maximum_protocol_version: 'TLSv1_3',
            },
          },
        },
      };
    }

    return modelInfo;
  }

  private async ensureImage(dockerode: Dockerode, image: string, logger?: Logger): Promise<void> {
    try {
      await dockerode.getImage(image).inspect();
      logger?.log(`Image ${image} is already available`);
      return;
    } catch (err: unknown) {
      if (!(err instanceof Error && 'statusCode' in err && err.statusCode === 404)) {
        console.warn(`vllm-semantic-router: failed to inspect image ${image}, pulling it`, err);
      }
    }
    await this.pullImage(dockerode, image, logger);
  }

  private async pullImage(dockerode: Dockerode, image: string, logger?: Logger): Promise<void> {
    logger?.log(`Pulling image ${image}...`);
    // progress events are emitted for every chunk: only report status changes per layer
    const layerStatuses = new Map<string, string>();
    const onProgress = (event: { id?: string; status?: string }): void => {
      if (!event.status) {
        return;
      }
      if (event.id) {
        if (layerStatuses.get(event.id) === event.status) {
          return;
        }
        layerStatuses.set(event.id, event.status);
        logger?.log(`${event.id}: ${event.status}`);
      } else {
        logger?.log(event.status);
      }
    };

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    try {
      const stream = await dockerode.pull(image);
      dockerode.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            reject(err);
          } else {
            logger?.log(`Image ${image} pulled`);
            resolve();
          }
        },
        onProgress,
      );
    } catch (err: unknown) {
      reject(err);
    }
    return promise;
  }

  dispose(): void {
    this.#endpointsSubscription?.dispose();
    this.#endpointsSubscription = undefined;
    this.#factoryDisposable?.dispose();
    this.#factoryDisposable = undefined;
    for (const managed of this.#connections.values()) {
      managed.disposable.dispose();
    }
    this.#connections.clear();
  }
}
