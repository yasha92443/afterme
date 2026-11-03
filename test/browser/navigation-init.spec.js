// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {test,expect} from '@playwright/test';

test('a sidebar click before PDF client loading finishes selects that page after initialization',async({page,request})=>{
  await request.post('/__fixture/reset');
  await page.request.post('/api/session',{data:{admin_token:'synthetic-browser-admin'}});
  let releaseAsset;const ready=new Promise(resolve=>releaseAsset=resolve);
  await page.route('**/static/pdf-client.js?*',async route=>{await ready;await route.continue();});
  try {
    await page.goto('/admin',{waitUntil:'commit'});
    await page.locator('[data-nav="people"]').click();
    await expect(page).toHaveURL(/#people$/);
  }finally{releaseAsset();}
  await expect(page.locator('#view-people .am-view-body')).toHaveAttribute('data-loaded','1');
  await expect(page.locator('#view-people')).toBeVisible();
  await expect(page.locator('#view-home')).toBeHidden();
});
