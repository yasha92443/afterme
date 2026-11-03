// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {DurableObject} from 'cloudflare:workers';
import edge, {createDurableRuntimeClass} from './execution-runtime.js';

export class AfterMeRuntime extends createDurableRuntimeClass(DurableObject) {}
export default edge;
