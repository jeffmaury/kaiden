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
import { beforeEach, expect, test, vi } from 'vitest';

import type { GatewayInfo } from '/@api/openshell-gateway-info.js';

import { OpenshellProfileSyncer } from './openshell-profile-syncer.js';
import { OpenshellSdkClientManager } from './openshell-sdk-client-manager.js';

vi.mock(import('./openshell-sdk-client-manager.js'));

let gatewayUpdateCallback: ((gateways: readonly GatewayInfo[]) => void) | undefined;
let profileRegisterCallback: ((profile: ProviderProfile) => void) | undefined;

const gatewayStateManager = {
  onDidUpdateGateways: vi.fn((cb: (gateways: readonly GatewayInfo[]) => void) => {
    gatewayUpdateCallback = cb;
    return { dispose: vi.fn() };
  }),
  listGateways: vi.fn<() => readonly GatewayInfo[]>().mockReturnValue([]),
  markProfilesSynced: vi.fn(),
};

const registry = {
  onDidRegisterProfile: vi.fn((cb: (profile: ProviderProfile) => void) => {
    profileRegisterCallback = cb;
    return { dispose: vi.fn() };
  }),
  getProfiles: vi.fn<() => readonly ProviderProfile[]>().mockReturnValue([]),
};

const listProviderProfiles = vi.fn();
const importProviderProfiles = vi.fn();

const sdkClientManager = new OpenshellSdkClientManager({} as never, {} as never);

const profileA = { id: 'anthropic' } as ProviderProfile;
const profileB = { id: 'openai' } as ProviderProfile;

function reachableGateway(name: string, synced: boolean): GatewayInfo {
  return {
    name,
    endpoint: `http://127.0.0.1:17670`,
    gatewayState: { reachable: true, health: 'healthy' },
    profilesSynced: synced,
  };
}

let syncer: OpenshellProfileSyncer;

beforeEach(() => {
  vi.resetAllMocks();
  gatewayUpdateCallback = undefined;
  profileRegisterCallback = undefined;

  registry.getProfiles.mockReturnValue([]);
  gatewayStateManager.listGateways.mockReturnValue([]);
  listProviderProfiles.mockResolvedValue({ profiles: [] });
  importProviderProfiles.mockResolvedValue({ diagnostics: [], profiles: [], imported: true });

  vi.mocked(sdkClientManager.getClient).mockResolvedValue({
    raw: { listProviderProfiles, importProviderProfiles },
  } as never);

  syncer = new OpenshellProfileSyncer(registry as never, gatewayStateManager as never, sdkClientManager);
  syncer.init();
});

test('imports missing profiles when a gateway becomes reachable and not yet synced', async () => {
  registry.getProfiles.mockReturnValue([profileA, profileB]);
  listProviderProfiles.mockResolvedValue({ profiles: [{ id: 'openai' }] });

  gatewayUpdateCallback!([reachableGateway('local', false)]);
  await vi.waitFor(() => expect(importProviderProfiles).toHaveBeenCalled());

  const call = importProviderProfiles.mock.calls[0]![0];
  expect(call.workspace).toBe('');
  expect(call.profiles).toHaveLength(1);
  expect(call.profiles[0].source).toBe('kaiden');
  expect(call.profiles[0].profile.id).toBe('anthropic');
  expect(gatewayStateManager.markProfilesSynced).toHaveBeenCalledWith('local');
});

test('marks synced without importing when all profiles already exist on gateway', async () => {
  registry.getProfiles.mockReturnValue([profileA]);
  listProviderProfiles.mockResolvedValue({ profiles: [{ id: 'anthropic' }] });

  gatewayUpdateCallback!([reachableGateway('local', false)]);
  await vi.waitFor(() => expect(gatewayStateManager.markProfilesSynced).toHaveBeenCalledWith('local'));

  expect(importProviderProfiles).not.toHaveBeenCalled();
});

test('marks synced without calling SDK when no profiles are registered', async () => {
  registry.getProfiles.mockReturnValue([]);

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
  registry.getProfiles.mockReturnValue([profileA]);
  listProviderProfiles.mockRejectedValue(new Error('gateway unreachable'));
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  gatewayUpdateCallback!([reachableGateway('local', false)]);
  await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());

  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gateway unreachable'));
  expect(gatewayStateManager.markProfilesSynced).not.toHaveBeenCalled();
  warnSpy.mockRestore();
});

test('imports single profile to synced gateways when a new profile is registered', async () => {
  gatewayStateManager.listGateways.mockReturnValue([reachableGateway('local', true)]);
  listProviderProfiles.mockResolvedValue({ profiles: [] });

  profileRegisterCallback!(profileA);
  await vi.waitFor(() => expect(importProviderProfiles).toHaveBeenCalled());

  expect(sdkClientManager.getClient).toHaveBeenCalledWith('local');
  const call = importProviderProfiles.mock.calls[0]![0];
  expect(call.profiles).toHaveLength(1);
  expect(call.profiles[0].profile.id).toBe('anthropic');
});

test('does not sync new profile to gateways that are not yet synced', () => {
  gatewayStateManager.listGateways.mockReturnValue([reachableGateway('local', false)]);

  profileRegisterCallback!(profileA);

  expect(sdkClientManager.getClient).not.toHaveBeenCalled();
});

test('does not import profile that already exists on gateway', async () => {
  gatewayStateManager.listGateways.mockReturnValue([reachableGateway('local', true)]);
  listProviderProfiles.mockResolvedValue({ profiles: [{ id: 'anthropic' }] });

  profileRegisterCallback!(profileA);
  await vi.waitFor(() => expect(listProviderProfiles).toHaveBeenCalled());

  expect(importProviderProfiles).not.toHaveBeenCalled();
});

test('catches and logs error when syncProfile fails', async () => {
  gatewayStateManager.listGateways.mockReturnValue([reachableGateway('local', true)]);
  vi.mocked(sdkClientManager.getClient).mockRejectedValue(new Error('connection lost'));
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  profileRegisterCallback!(profileA);
  await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());

  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  warnSpy.mockRestore();
});

test('dispose cleans up event subscriptions', () => {
  const gatewayDispose = gatewayStateManager.onDidUpdateGateways.mock.results[0]!.value;
  const registryDispose = registry.onDidRegisterProfile.mock.results[0]!.value;

  syncer.dispose();

  expect(gatewayDispose.dispose).toHaveBeenCalled();
  expect(registryDispose.dispose).toHaveBeenCalled();
});
