#!/usr/bin/env tsx
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
 **********************************************************************/

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO = 'NVIDIA/OpenShell';
const PROVIDERS_PATH = 'providers';
const OUTPUT_DIR = resolve(__dirname, '..', 'src', 'assets', 'openshell');
const VERSION_MARKER = '.profiles-version';

interface GitHubContentEntry {
  name: string;
  type: string;
  download_url: string | null;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function getOpenshellVersion(): string {
  const pkgPath = resolve(__dirname, '..', '..', '..', 'extensions', 'openshell', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { openshellVersion: string };
  if (!pkg.openshellVersion) {
    throw new Error('missing "openshellVersion" in extensions/openshell/package.json');
  }
  return pkg.openshellVersion;
}

async function isAlreadyDownloaded(version: string): Promise<boolean> {
  const markerPath = resolve(OUTPUT_DIR, VERSION_MARKER);
  if (!existsSync(markerPath)) {
    return false;
  }
  const existing = await readFile(markerPath, 'utf-8');
  return existing.trim() === version;
}

async function listProviderYamlFiles(version: string): Promise<GitHubContentEntry[]> {
  const url = `https://api.github.com/repos/${REPO}/contents/${PROVIDERS_PATH}?ref=v${version}`;
  const res = await fetch(url, { headers: getAuthHeaders(), redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`failed to list provider profiles at v${version}: ${res.status} ${res.statusText}`);
  }
  const entries = (await res.json()) as GitHubContentEntry[];
  return entries.filter(entry => entry.type === 'file' && entry.name.endsWith('.yaml'));
}

async function downloadFile(url: string): Promise<string> {
  const headers: Record<string, string> = {};
  const token = process.env['GITHUB_TOKEN'];
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function main(): Promise<void> {
  const version = getOpenshellVersion();
  console.log(`[download-provider-profiles] OpenShell version: v${version}`);

  if (await isAlreadyDownloaded(version)) {
    console.log(`[download-provider-profiles] profiles already downloaded for v${version}, skipping`);
    return;
  }

  const yamlFiles = await listProviderYamlFiles(version);
  if (yamlFiles.length === 0) {
    console.warn('[download-provider-profiles] no YAML files found in providers directory');
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`[download-provider-profiles] downloading ${yamlFiles.length} provider profiles`);
  for (const entry of yamlFiles) {
    if (!entry.download_url) {
      console.warn(`[download-provider-profiles] skipping ${entry.name}: no download URL`);
      continue;
    }
    const content = await downloadFile(entry.download_url);
    const destPath = resolve(OUTPUT_DIR, entry.name);
    await writeFile(destPath, content, 'utf-8');
    console.log(`[download-provider-profiles] downloaded ${entry.name}`);
  }

  await writeFile(resolve(OUTPUT_DIR, VERSION_MARKER), version, 'utf-8');
  console.log(`[download-provider-profiles] done`);
}

main().catch((err: unknown) => {
  console.error('[download-provider-profiles]', err);
  process.exit(1);
});
