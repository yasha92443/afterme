// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./test/browser',testMatch:'**/*.spec.js',fullyParallel:false,workers:1,
  timeout:45000,expect:{timeout:10000},reporter:'list',
  outputDir:'output/playwright/results',
  use:{baseURL:'http://127.0.0.1:8872',viewport:{width:1600,height:1000},headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||undefined,trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'node test/browser/fixture.mjs',url:'http://127.0.0.1:8872/__fixture/ready',reuseExistingServer:false,timeout:30000},
});
