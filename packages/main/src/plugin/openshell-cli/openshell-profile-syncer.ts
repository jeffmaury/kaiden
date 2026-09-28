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

import { create } from '@bufbuild/protobuf';
import { ProviderProfileImportItemSchema } from '@nvidia/openshell-sdk/raw';
import type { Disposable, ProviderProfile } from '@openkaiden/api';
import { inject, injectable, preDestroy } from 'inversify';

import { OpenshellGatewayStateManager } from '/@/plugin/openshell-cli/openshell-gateway-state-manager.js';
import { OpenshellSdkClientManager } from '/@/plugin/openshell-cli/openshell-sdk-client-manager.js';
import { OpenShellRegistry } from '/@/plugin/openshell-registry.js';
import type { IDisposable } from '/@api/disposable.js';
import type { GatewayInfo } from '/@api/openshell-gateway-info.js';

@injectable()
export class OpenshellProfileSyncer implements Disposable {
  #disposables: IDisposable[] = [];

  constructor(
    @inject(OpenShellRegistry)
    private readonly registry: OpenShellRegistry,
    @inject(OpenshellGatewayStateManager)
    private readonly gatewayStateManager: OpenshellGatewayStateManager,
    @inject(OpenshellSdkClientManager)
    private readonly sdkClientManager: OpenshellSdkClientManager,
  ) {}

  init(): void {
    this.#disposables.push(
      this.gatewayStateManager.onDidUpdateGateways((gateways: readonly GatewayInfo[]) => {
        for (const gw of gateways) {
          if (gw.gatewayState?.reachable && !gw.profilesSynced) {
            this.syncAllProfiles(gw.name).catch((err: unknown) => {
              console.warn(
                `[openshell-profile-syncer] failed to sync profiles to gateway "${gw.name}": ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        }
      }),
    );

    this.#disposables.push(
      this.registry.onDidRegisterProfile((profile: ProviderProfile) => {
        const syncedGateways = this.gatewayStateManager
          .listGateways()
          .filter(gw => gw.gatewayState?.reachable);
        for (const gw of syncedGateways) {
          this.syncProfile(profile, gw.name).catch((err: unknown) => {
            console.warn(
              `[openshell-profile-syncer] failed to sync profile "${profile.id}" to gateway "${gw.name}": ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }),
    );
  }

  private async syncAllProfiles(gatewayName: string): Promise<void> {
    const registeredProfiles = this.registry.getProfiles();
    if (registeredProfiles.length === 0) {
      this.gatewayStateManager.markProfilesSynced(gatewayName);
      return;
    }

    const client = await this.sdkClientManager.getClient(gatewayName);
    const { profiles: existingProfiles } = await client.raw.listProviderProfiles({ workspace: 'default' });
    const existingIds = new Set(existingProfiles.map(p => p.id));

    const missingProfiles = registeredProfiles.filter(p => !existingIds.has(p.id));
    if (missingProfiles.length > 0) {
      const importItems = missingProfiles.map(profile =>
        create(ProviderProfileImportItemSchema, { profile, source: 'kaiden' }),
      );

      const response = await client.raw.importProviderProfiles({ profiles: importItems, workspace: '' });
      if (!response.imported) {
        throw new Error(`Error while importing provider profiles on gateway: ${gatewayName}`);
      }
      for (const d of response.diagnostics) {
        console.warn(`[openshell-profile-syncer] import diagnostic for "${d.profileId}": ${d.message}`);
      }
      console.log(`[openshell-profile-syncer] synced ${missingProfiles.length} profile(s) to gateway "${gatewayName}"`);
    }

    this.gatewayStateManager.markProfilesSynced(gatewayName);
  }

  private async syncProfile(profile: ProviderProfile, gatewayName: string): Promise<void> {
    const client = await this.sdkClientManager.getClient(gatewayName);
    const { profiles: existingProfiles } = await client.raw.listProviderProfiles({ workspace: '' });
    if (existingProfiles.some(p => p.id === profile.id)) return;

    const importItem = create(ProviderProfileImportItemSchema, { profile, source: 'kaiden' });
    const response = await client.raw.importProviderProfiles({ profiles: [importItem], workspace: '' });
    if (!response.imported) {
      throw new Error(`Error while importing provider profile ${profile.id} on gateway: ${gatewayName}`);
    }
    for (const d of response.diagnostics) {
      console.warn(`[openshell-profile-syncer] import diagnostic for "${d.profileId}": ${d.message}`);
    }
    console.log(`[openshell-profile-syncer] synced profile "${profile.id}" to gateway "${gatewayName}"`);
  }

  @preDestroy()
  dispose(): void {
    for (const d of this.#disposables) {
      d.dispose();
    }
    this.#disposables = [];
  }
}
