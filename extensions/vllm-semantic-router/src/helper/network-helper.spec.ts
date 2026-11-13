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

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { NetworkHelper } from './network-helper';

let helper: NetworkHelper;

beforeEach(() => {
  vi.resetAllMocks();
  helper = new NetworkHelper();
});

describe('convertHost', () => {
  test.each([
    ['localhost', 'host.docker.internal'],
    ['api.example.com', 'api.example.com'],
    ['127.0.0.1', 'host.docker.internal'],
  ])('converts %s to %s', (host, expected) => {
    expect(helper.convertHost(host)).toBe(expected);
  });
});
