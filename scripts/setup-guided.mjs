// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { readFile,writeFile,access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin,stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {BACKGROUND_LANE_CRONS} from '../src/background-scheduler.js';

function triggerSchedules(text){
  const headers=[...text.matchAll(/^\s*\[triggers\]\s*(?:#.*)?$/gm)];if(headers.length!==1)return null;const header=headers[0];
  const rest=text.slice(header.index+header[0].length),end=rest.search(/^\s*\[/m),section=end<0?rest:rest.slice(0,end);
  const declarations=[...section.matchAll(/^\s*crons\s*=\s*\[([\s\S]*?)\]/gm)];if(declarations.length!==1)return null;
  try{const values=JSON.parse('['+declarations[0][1].replace(/#[^\r\n]*/g,'').replace(/,\s*$/,'')+']');return Array.isArray(values)&&values.every(value=>typeof value==='string')?values:null;}catch{return null;}
}

export function checkConfiguration(text) {
  const value=k=>text.match(new RegExp('^'+k+'\\s*=\\s*"([^"\\r\\n]*)"','m'))?.[1];
  const provider=value('MAIL_PROVIDER'),inbound=value('INBOUND_PROVIDER')||(provider==='gmail'&&value('MAIL_INBOUND_ENABLED')!=='false'?'gmail':null);
  const errors=[];
  const runtime=value('EXECUTION_RUNTIME')||'worker';
  if(!['worker','durable-object'].includes(runtime))errors.push('执行模式应为 worker 或 durable-object / Invalid execution runtime');
  if(runtime==='durable-object'){
    if(value('main')!=='src/durable-worker.js')errors.push('DO 模式使用 src/durable-worker.js 入口 / Use the Durable Object entrypoint');
    const objects=text.split(/^\s*\[\[durable_objects.bindings\]\]\s*$/m).slice(1).map(block=>block.split(/^\s*\[/m)[0]);
    if(!objects.some(block=>/^name\s*=\s*"APP_RUNTIME"\s*$/m.test(block)&&/^class_name\s*=\s*"AfterMeRuntime"\s*$/m.test(block)&&!/^script_name\s*=/m.test(block)))errors.push('配置本部署的 APP_RUNTIME / AfterMeRuntime 绑定 / Bind the deployment-local runtime');
    const migrations=text.split(/^\s*\[\[migrations\]\]\s*$/m).slice(1).map(block=>block.split(/^\s*\[/m)[0]);
    if(!migrations.some(block=>/^tag\s*=\s*"[^"\r\n]+"/m.test(block)&&/^new_sqlite_classes\s*=\s*\[\s*"AfterMeRuntime"\s*\]/m.test(block)))errors.push('免费 DO 需要 SQLite 类迁移 / Free Durable Objects require a SQLite class migration');
    if(value('BACKGROUND_EXECUTION_MODE')!=='staged'||value('BACKGROUND_LANE_SCHEDULING')!=='true')errors.push('DO 部署配置需要分阶段执行与三路调度 / Durable deployment requires staged background lanes');
    if(/^\s*cpu_ms\s*=/m.test(text))errors.push('免费配置不设置付费 CPU 限额 / Omit paid CPU limit overrides');
  }
  const crons=triggerSchedules(text),staged=value('BACKGROUND_EXECUTION_MODE')==='staged',lanes=value('BACKGROUND_LANE_SCHEDULING')==='true';
  if(lanes){
    const required=Object.values(BACKGROUND_LANE_CRONS);
    if(!staged)errors.push('独立后台调度需要 staged 执行模式 / Background lanes require staged execution');
    if(!crons||crons.length!==required.length||new Set(crons).size!==required.length||!required.every(cron=>crons.includes(cron)))errors.push('独立后台调度需要收件、控制及工作三条指定 Cron / Configure all three background lane schedules');
  }else{
    const cron=crons?.[0];
    if(!crons||crons.length!==1||!/^(?:[0-5]?\d|\*\/5|\*) \* \* \* \*$/.test(cron||''))errors.push('Cron 应每分钟、每 5 分钟或每小时检查 / Use a minute, five-minute or hourly Cron');
    if(staged&&cron!=='* * * * *')errors.push('单路分阶段后台任务需要每分钟 Cron / Single-lane staged execution requires a minute Cron');
  }
  if(value('BACKGROUND_EXECUTION_MODE')==='staged'&&provider==='resend')errors.push('分阶段附件传输目前仅支持 Gmail 或 dry-run / Staged attachments require Gmail or dry-run');
  if(!value('database_id')||/replace|your-|^00000000-0000-4000-8000-000000000000$/.test(value('database_id')))errors.push('填写自己的 D1 database_id / D1 database_id required');
  if(!['gmail','resend','dry-run'].includes(provider))errors.push('请选择 Gmail、Resend 或 dry-run');
  if(provider!=='dry-run'&&!['gmail','web'].includes(inbound))errors.push('明确选择 Gmail 收回复或验证网页 / Choose verification reply path');
  if(provider==='resend'&&(!value('FROM_EMAIL')||value('FROM_EMAIL').endsWith('.invalid')))errors.push('Resend 需要已验证的寄信域名与地址 / Verified sending address required');
  if(inbound==='gmail'&&!value('VERIFICATION_EMAIL')&&provider!=='gmail')errors.push('填写专用 Gmail 回复地址 VERIFICATION_EMAIL');
  if(!/^\d+$/.test(value('MAX_DAILY_EMAILS')||'')||Number(value('MAX_DAILY_EMAILS'))<1)errors.push('设置有效每日发信额度 / Set a daily mail cap');
  const bindings=text.split(/^\[\[ratelimits\]\]\s*$/m).slice(1).map(block=>block.split(/^\[(?!\[ratelimits\]\])/m)[0]);
  if(!['LOGIN_LIMITER','VERIFY_LIMITER','EXPENSIVE_LIMITER','API_LIMITER','READ_LIMITER'].every(name=>bindings.some(block=>new RegExp('^name\\s*=\\s*"'+name+'"\\s*$','m').test(block)&&/^namespace_id\s*=\s*"\d+"\s*$/m.test(block)&&/^simple\s*=\s*\{\s*limit\s*=\s*[1-9]\d*\s*,\s*period\s*=\s*60\s*\}\s*$/m.test(block))))errors.push('配置全部五个有效原生限流绑定 / All five native rate limit bindings are required');
  if(/^ALLOW_LOCAL_RATE_LIMIT_FALLBACK\s*=\s*(?:"true"|true)(?:\s|$)/m.test(text))errors.push('部署时关闭本地限流 fallback / Disable local rate-limit fallback for deployment');
  if(!/\[assets\]/.test(text)||!text.includes('binding = "PDF_FONTS"')||!/^run_worker_first\s*=\s*true\s*$/m.test(text))errors.push('保留 PDF_FONTS 字体资源绑定与 Worker 优先路由 / Keep PDF font assets and Worker-first routing');
  if(!/^compatibility_flags\s*=\s*\[[^\]\r\n]*"nodejs_compat"[^\]\r\n]*\]/m.test(text))errors.push('保留 nodejs_compat / Native server codecs require nodejs_compat');
  if(value('PDF_GENERATION_MODE')!=='browser')errors.push('免费部署引导要求浏览器 PDF 准备 / Use browser PDF preparation for this setup');
  return {ok:errors.length===0,provider,inbound,crons,background_lanes:lanes,execution_runtime:runtime,errors};
}
async function main() {
  const path=resolve(process.argv[process.argv.indexOf('--config')+1]&&process.argv.includes('--config')?process.argv[process.argv.indexOf('--config')+1]:'wrangler.toml');
  if(process.argv.includes('--check')){const result=checkConfiguration(await readFile(path,'utf8'));console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;return;}
  console.log(`AfterMe · 独立部署引导 / Guided setup\n\nWorker 运行程序和验证网页；D1 保存内容、规则和投递额度；示例 Cron 每 5 分钟分批推进状态。\nGmail / Resend 负责寄信。核验收信是独立路径：专用 Gmail 回复，或联系人打开验证网页。\n每人使用自己的实例和密钥。套餐由您在服务商管理；真实邮件测试使用单独的显式演练命令。\n`);
  const rl=createInterface({input:stdin,output:stdout});
  try {
    let config=await readFile(path,'utf8').catch(()=>null);
    if(!config) {
      const provider=(await rl.question('寄信服务 gmail / resend / dry-run [dry-run]: ')).trim()||'dry-run';
      if(!['gmail','resend','dry-run'].includes(provider))throw Error('Unknown provider');
      const inbound=provider==='dry-run'?'web':(await rl.question('核验路径 gmail / web [web]: ')).trim()||'web';
      if(!['gmail','web'].includes(inbound))throw Error('Choose a reachable verification path');
      const db=(await rl.question('D1 database_id（先用 npx wrangler d1 create afterme 创建）: ')).trim();
      const base=(await rl.question('Worker HTTPS 地址: ')).trim();if(new URL(base).protocol!=='https:')throw Error('HTTPS required');
      const from=(await rl.question('寄信邮箱（Resend 使用已验证域名）: ')).trim();
      const verify=inbound==='gmail'?(await rl.question('专用 Gmail 回复邮箱: ')).trim():'';
      config=(await readFile(new URL('../wrangler.example.toml',import.meta.url),'utf8')).replace('00000000-0000-4000-8000-000000000000',db).replace('https://afterme.your-subdomain.workers.dev',base).replace('MAIL_PROVIDER = "dry-run"',`MAIL_PROVIDER = "${provider}"`).replace('afterme@example.invalid',from).replace('INBOUND_PROVIDER = "web"',`INBOUND_PROVIDER = "${inbound}"\nVERIFICATION_EMAIL = ${JSON.stringify(verify)}`).replace('MAIL_INBOUND_ENABLED = "false"',`MAIL_INBOUND_ENABLED = "${inbound==='gmail'}"`);
      if([db,base,from,verify].some(v=>/["\r\n]/.test(v)))throw Error('Invalid configuration values');
      await writeFile(path,config,{flag:'wx'});console.log('配置已写入；现有文件保留原样。');
    } else console.log('发现现有配置；保留全部现有设置。');
    const checks=checkConfiguration(config);console.log(JSON.stringify(checks,null,2));if(!checks.ok){process.exitCode=1;return;}
    console.log(`\nADMIN_TOKEN 是管理口令，CONTENT_ENCRYPTION_KEY 是独立内容密钥；两者必须分别设置。\n使用 npx wrangler secret put NAME 输入密钥；不要把密钥放进 TOML、日志或公共仓库。\nGmail 寄信或收信需要 GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET、GMAIL_REFRESH_TOKEN。\nGoogle OAuth 外部应用处于 Testing 时，Gmail scope 的刷新令牌通常在七天后过期。授权失效会阻止释放；运行 npm run gmail:oauth 重新授权，再更新 secret。\nhttps://developers.google.com/identity/protocols/oauth2\nResend 需要 RESEND_API_KEY、验证域名和所选套餐允许的额度。套餐由您在 Resend 自行选择并管理购买或升级。\nGmail 回复路径需要同一已授权邮箱能收到 VERIFICATION_EMAIL 的邮件；网页路径需要联系人能打开 Worker HTTPS 地址。\n先完成密钥配置，然后迁移数据库、部署。第一次登录请设置本人资料和规则；本人签到后规则才生效。\n`);
    for(const [label,args] of [['登录 Cloudflare',['login']],['迁移自己的 D1',['d1','migrations','apply',config.match(/database_name\s*=\s*"([^"]+)"/)?.[1]||'afterme','--remote']],['部署',['deploy']]]){
      const answer=(await rl.question(`${label}，现在执行？ y / n [n]: `)).trim().toLowerCase();if(answer!=='y')continue;
      if(label==='部署')await new Promise((res,rej)=>{const child=spawn(process.execPath,[resolve('scripts/build-browser.mjs')],{stdio:'inherit',windowsHide:true});child.on('error',rej);child.on('exit',code=>code===0?res():rej(Error(`Browser build failed (${code})`)));});
      await new Promise((res,rej)=>{const child=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),...args,'--config',path],{stdio:'inherit',windowsHide:true});child.on('error',rej);child.on('exit',code=>code===0?res():rej(Error(`${label} failed (${code})`)));});
    }
    console.log('上线后检查 /health/operational，并等第一个自然 Cron。不要靠手动确认来试验真实收件人。');
  } finally {rl.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
