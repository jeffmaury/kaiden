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

import type { ProviderProfile } from '@openkaiden/api';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { GatewayInfo } from '/@api/openshell-gateway-info.js';

import { OpenShellRegistry } from '../openshell-registry.js';
import { OpenshellGatewayStateManager } from './openshell-gateway-state-manager.js';
import { OpenshellProfileSyncer } from './openshell-profile-syncer.js';
import { OpenshellSdkClientManager } from './openshell-sdk-client-manager.js';

vi.mock(import('../openshell-registry.js'));
vi.mock(import('./openshell-gateway-state-manager.js'));
vi.mock(import('./openshell-sdk-client-manager.js'));

let gatewayUpdateCallback: ((gateways: readonly GatewayInfo[]) => void) | undefined;
let profileRegisterCallback: ((profile: ProviderProfile) => void) | undefined;
const originalConsoleWarn = console.warn;

let registry: OpenShellRegistry;
let gatewayStateManager: OpenshellGatewayStateManager;

const listProviderProfiles = vi.fn();
const importProviderProfiles = vi.fn();

const sdkClientManager = new OpenshellSdkClientManager({} as never, {} as never);

const profileA = { id: 'anthropic' } as ProviderProfile;
const profileB = { id: 'openai' } as ProviderProfile;

function reachableGateway(name: string, synced: boolean): GatewayInfo {
  return {
    name,
    endpoint: 'http://127.0.0.1:17670',
    gatewayState: { reachable: true, health: 'healthy' },
    profilesSynced: synced,
  };
}

let syncer: OpenshellProfileSyncer;

beforeEach(() => {
  vi.resetAllMocks();
  console.warn = vi.fn();
  gatewayUpdateCallback = undefined;
  profileRegisterCallback = undefined;

  registry = new OpenShellRegistry({} as never, {} as never);
  Object.defineProperty(registry, 'onDidRegisterProfile', {
    value: vi.fn(cb => {
      profileRegisterCallback = cb;
      return { dispose: vi.fn() };
    }),
  });
  gatewayStateManager = new OpenshellGatewayStateManager({} as never, {} as never, {} as never);
  Object.defineProperty(gatewayStateManager, 'onDidUpdateGateways', {
    value: vi.fn(cb => {
      gatewayUpdateCallback = cb;
      return { dispose: vi.fn() };
    }),
  });

  vi.mocked(registry.getProfiles).mockReturnValue([]);
  vi.mocked(gatewayStateManager.listGateways).mockReturnValue([]);
  listProviderProfiles.mockResolvedValue({ profiles: [] });
  importProviderProfiles.mockResolvedValue({ diagnostics: [], profiles: [], imported: true });

  vi.mocked(sdkClientManager.getClient).mockResolvedValue({
    raw: { listProviderProfiles, importProviderProfiles },
  } as never);

  syncer = new OpenshellProfileSyncer(registry, gatewayStateManager, sdkClientManager);
  syncer.init();
});

afterEach(() => {
  console.warn = originalConsoleWarn;
});

test('imports missing profiles when a gateway becomes reachable and not yet synced', async () => {
  vi.mocked(registry.getProfiles).mockReturnValue([profileA, profileB]);
  listProviderProfiles.mockResolvedValue({ profiles: [{ id: 'openai' }] });

  gatewayUpdateCallback!([reachableGateway('local', false)]);
  await vi.waitFor(() => expect(importProviderProfiles).toHaveBeenCalled());

  expect(importProviderProfiles).toHaveBeenCalledWith(
    expect.objectContaining({
      profiles: expect.arrayContaining([
        expect.objectContaining({
          profile: expect.objectContaining({
            id: 'anthropic',
          }),
          source: 'kaiden',
        }),
      ]),
    }),
  );
  expect(gatewayStateManager.markProfilesSynced).toHaveBeenCalledWith('local');
});

test('marks synced without importing when all profiles already exist on gateway', async () => {
  vi.mocked(registry.getProfiles).mockReturnValue([profileA]);
  listProviderProfiles.mockResolvedValue({ profiles: [{ id: 'anthropic' }] });

  gatewayUpdateCallback!([reachableGateway('local', false)]);
  await vi.waitFor(() => expect(gatewayStateManager.markProfilesSynced).toHaveBeenCalledWith('local'));

  expect(importProviderProfiles).not.toHaveBeenCalled();
});

test('marks synced without calling SDK when no profiles are registered', async () => {
  vi.mocked(registry.getProfiles).mockReturnValue([]);

  gatewayUpdateCallback!([reachableGateway('local', false)]);
  await vi.waitFor(() => expect(gatewayStateManager.markProfilesSynced).toHaveBeenCalledWith('local'));

  expect(sdkClientManager.getClient).not.toHaveBeenCalled();
});

test('skips gateways that are already synced', () => {
  gatewayUpdateCallback!([reachableGateway('local', true)]);

  expect(sdkClientManager.getClient).not.toHaveBeenCalled();
  expect(gatewayStateManager.markProfilesSynced).not.toHaveBeenCalled();
});

test('catches and logs error when sync fails on gateway update', async () => {
  vi.mocked(registry.getProfiles).mockReturnValue([profileA]);
  listProviderProfiles.mockRejectedValue(new Error('gateway unreachable'));

  gatewayUpdateCallback!([reachableGateway('local', false)]);
  await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());

  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('gateway unreachable'));
  expect(gatewayStateManager.markProfilesSynced).not.toHaveBeenCalled();
});

test('imports single profile to synced gateways when a new profile is registered', async () => {
  vi.mocked(gatewayStateManager.listGateways).mockReturnValue([reachableGateway('local', true)]);
  listProviderProfiles.mockResolvedValue({ profiles: [] });

  profileRegisterCallback!(profileA);
  await vi.waitFor(() => expect(importProviderProfiles).toHaveBeenCalled());

  expect(sdkClientManager.getClient).toHaveBeenCalledWith('local');
  expect(importProviderProfiles).toHaveBeenCalledWith(
    expect.objectContaining({
      profiles: expect.arrayContaining([
        expect.objectContaining({
          profile: expect.objectContaining({
            id: 'anthropic',
          }),
          source: 'kaiden',
        }),
      ]),
    }),
  );
});

test('does not sync new profile to gateways that are not yet synced', () => {
  vi.mocked(gatewayStateManager.listGateways).mockReturnValue([reachableGateway('local', false)]);

  profileRegisterCallback!(profileA);

  expect(sdkClientManager.getClient).not.toHaveBeenCalled();
});

test('does not import profile that already exists on gateway', async () => {
  vi.mocked(gatewayStateManager.listGateways).mockReturnValue([reachableGateway('local', true)]);
  listProviderProfiles.mockResolvedValue({ profiles: [{ id: 'anthropic' }] });

  profileRegisterCallback!(profileA);
  await vi.waitFor(() => expect(listProviderProfiles).toHaveBeenCalled());

  expect(importProviderProfiles).not.toHaveBeenCalled();
});

test('catches and logs error when syncProfile fails', async () => {
  vi.mocked(gatewayStateManager.listGateways).mockReturnValue([reachableGateway('local', true)]);
  vi.mocked(sdkClientManager.getClient).mockRejectedValue(new Error('connection lost'));

  profileRegisterCallback!(profileA);
  await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());

  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
});

test('dispose cleans up event subscriptions', () => {
  const gatewayDispose = vi.mocked(gatewayStateManager.onDidUpdateGateways).mock.results[0]!.value;
  const registryDispose = vi.mocked(registry.onDidRegisterProfile).mock.results[0]!.value;

  syncer.dispose();

  expect(gatewayDispose.dispose).toHaveBeenCalled();
  expect(registryDispose.dispose).toHaveBeenCalled();
});
