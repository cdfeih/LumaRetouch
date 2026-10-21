/** Real local automatic per-photo/per-face batch acceptance; no remote models or private photos. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const baseUrl=process.env.LUMA_TEST_URL||'http://127.0.0.1:5178',output=path.resolve('artifacts/batch-automatic');await mkdir(output,{recursive:true});
const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(60000);
const checks=[],errors=[],external=[];let modelCalls=0;
page.on('pageerror',error=>errors.push(error.message));await context.routeWebSocket('**/*',socket=>socket.close());
await context.route('**/*',route=>{const url=route.request().url();if(url.includes('/__native/request')){modelCalls++;return route.abort();}if(url.startsWith(baseUrl)||/^(data:|blob:)/.test(url))return route.continue();external.push(url);return route.abort();});
const batch=page.getByTestId('batch-studio'),rows=()=>batch.locator('.batch-row');
const idle=()=>batch.getByTestId('batch-cancel').waitFor({state:'hidden'});
async function open(){await page.getByTestId('open-batch').click();await page.waitForFunction(()=>!document.querySelector('.batch-studio')?.textContent.includes('正在恢复本地结果记录'));}
async function records(){return page.evaluate(async()=>Promise.all((await(await import('/src/batch/storage.ts')).listBatchResults()).map(async record=>({id:record.id,name:record.name,settings:record.settings,automatic:record.automatic,review:record.review,starred:record.starred,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await record.blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('')}))));}
async function chooseOnly(name){await batch.getByRole('button',{name:'取消选择',exact:true}).click();await rows().filter({hasText:name}).getByRole('checkbox').check();}
async function check(name,action){const start=Date.now(),evidence=await action();checks.push({name,passed:true,elapsedMs:Date.now()-start,...evidence});console.log(`PASS ${name}`);}
try{
await page.goto(baseUrl,{waitUntil:'networkidle'});await open();
const bytes=await readFile('tests/fixtures/mediapipe-portrait.jpg'),portrait={name:'smart-normal.jpg',mimeType:'image/jpeg',buffer:bytes};
const source=`data:image/jpeg;base64,${bytes.toString('base64')}`;
const variants=await page.evaluate(async source=>{
 const {applyAdjustments,DEFAULT_ADJUSTMENTS}=await import('/src/imaging/index.ts');const dark=await applyAdjustments(source,{...DEFAULT_ADJUSTMENTS,exposure:-1.2});
 const original=new Image();original.src=source;await original.decode();const darker=new Image();darker.src=dark;await darker.decode();
 const group=document.createElement('canvas');group.width=original.naturalWidth*2;group.height=original.naturalHeight;const ctx=group.getContext('2d');ctx.drawImage(original,0,0);ctx.drawImage(darker,original.naturalWidth,0);
 const white=document.createElement('canvas');white.width=320;white.height=240;const wx=white.getContext('2d');wx.fillStyle='white';wx.fillRect(0,0,320,240);
 return{dark,group:group.toDataURL(),white:white.toDataURL()};
},source);
const png=(name,data)=>({name,mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')});
let first,groupBeforeCancel;
await check('默认三种智能方案明确区别手动，先试1张保留逐脸实际计划',async()=>{
 assert.equal(await batch.getByTestId('batch-preset').inputValue(),'smart:natural');
 assert.equal(await batch.getByTestId('batch-preset').locator('optgroup[label="智能 · 逐张分析，不塑形"] option').count(),3);
 assert.equal(await batch.locator('.batch-parameters').count(),0);assert.match(await batch.getByTestId('batch-smart-description').innerText(),/逐张分析/);
 await batch.getByTestId('batch-file-input').setInputFiles([portrait,png('smart-dark.png',variants.dark)]);
 await batch.getByTestId('batch-trial').click();await idle();
 const saved=await records();assert.equal(saved.length,1);first=saved[0];assert.equal(first.automatic.profile,'natural');
 assert.ok(first.automatic.subjects.length>0);assert.ok(first.automatic.steps.some(step=>step.includes('分析')));assert.ok(first.automatic.steps.some(step=>step.includes('修饰')));
 assert.ok(Object.values(first.settings).every(value=>value===0),'Legacy global preset field must not impersonate a face-specific smart plan');
 assert.equal(await rows().filter({hasText:'smart-dark.png'}).getAttribute('data-status'),'pending');
 await batch.getByTestId('batch-applied-plan').locator('summary').click();assert.match(await batch.getByTestId('batch-applied-plan').innerText(),/人物/);
 return{profile:first.automatic.profile,exposure:first.automatic.exposure,subjects:first.automatic.subjects};
});
await check('同原片重复智能不叠加，暗片独立分析得到不同曝光或人脸参数',async()=>{
 await batch.getByTestId('batch-run').click();await idle();const saved=await records();assert.equal(saved.length,2);
 const normal=saved.find(row=>row.name==='smart-normal.jpg'),dark=saved.find(row=>row.name==='smart-dark.png');assert.equal(normal.sha256,first.sha256);
 assert.notEqual(JSON.stringify([normal.automatic.exposure,normal.automatic.subjects.map(x=>x.settings)]),JSON.stringify([dark.automatic.exposure,dark.automatic.subjects.map(x=>x.settings)]));
 return{normalExposure:normal.automatic.exposure,darkExposure:dark.automatic.exposure,normalSettings:normal.automatic.subjects.map(x=>x.settings),darkSettings:dark.automatic.subjects.map(x=>x.settings)};
});
await check('智能通透只重处理选中原片，其他已完成照片不被改写',async()=>{
 const normal=(await records()).find(row=>row.name==='smart-normal.jpg');await chooseOnly('smart-dark.png');await batch.getByTestId('batch-preset').selectOption('smart:bright');
 await batch.getByTestId('batch-run').click();await idle();const saved=await records();assert.deepEqual(saved.find(row=>row.name==='smart-normal.jpg'),normal);
 const dark=saved.find(row=>row.name==='smart-dark.png');assert.equal(dark.automatic.profile,'bright');assert.ok(Math.abs(dark.automatic.exposure)<=.5);return{exposure:dark.automatic.exposure};
});
await check('智能保纹理为同图两张脸分别计划，批量与共享单张渲染逐字节一致',async()=>{
 await batch.getByTestId('batch-file-input').setInputFiles(png('smart-group.png',variants.group));await chooseOnly('smart-group.png');await batch.getByTestId('batch-preset').selectOption('smart:texture');
 await batch.getByTestId('batch-trial').click();await idle();const group=(await records()).find(row=>row.name==='smart-group.png');assert.ok(group);assert.equal(group.automatic.profile,'texture');
 assert.equal(group.automatic.subjects.length,2);assert.notDeepEqual(group.automatic.subjects[0].settings,group.automatic.subjects[1].settings);
 const shape=['faceSlim','jawSlim','chinLength','waistSlim','armSlim','legSlim','shoulderWidth'];assert.ok(group.automatic.subjects.every(subject=>shape.every(field=>subject.settings[field]===0)&&subject.settings.smoothing<=6));
 const sharedHash=await page.evaluate(async source=>{const {renderAutomaticRetouch}=await import('/src/portrait/auto-render.ts');const result=await renderAutomaticRetouch(source,{profile:'texture'});const blob=await(await fetch(result.image)).blob();return[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');},variants.group);assert.equal(sharedHash,group.sha256);
 await batch.getByLabel('当前成片复核状态',{exact:true}).selectOption('approved');await idle();groupBeforeCancel=(await records()).find(row=>row.name==='smart-group.png');
 return{subjects:group.automatic.subjects,sharedHash};
});
await check('智能处理中取消保留上次已复核成片，迟到写入清理后可重试',async()=>{
 await page.evaluate(()=>{const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');window.__autoCompletion=descriptor;Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(handler){descriptor.set.call(this,typeof handler==='function'&&this.mode==='readwrite'?function(event){setTimeout(()=>handler.call(this,event),1200)}:handler)}});});
 await batch.getByTestId('batch-preset').selectOption('smart:natural');await batch.getByTestId('batch-run').click();await batch.getByTestId('batch-cancel').waitFor();
 await page.waitForFunction(async()=>(await(await import('/src/batch/storage.ts')).listBatchResults()).length===4);
 await batch.getByTestId('batch-cancel').click();await idle();await page.waitForTimeout(1600);
 assert.deepEqual((await records()).find(row=>row.name==='smart-group.png'),groupBeforeCancel);assert.equal((await records()).length,3);
 await page.evaluate(()=>Object.defineProperty(IDBTransaction.prototype,'oncomplete',window.__autoCompletion));
 await batch.getByTestId('batch-retry').click();await idle();const group=(await records()).find(row=>row.name==='smart-group.png');assert.equal(group.automatic.profile,'natural');assert.equal(group.review,'pending');
 return{preservedCancelledId:groupBeforeCancel.id,retriedId:group.id};
});
await check('手动全零不会删除智能成片，无脸白片说明限制并保留未处理状态',async()=>{
 const before=(await records()).find(row=>row.name==='smart-group.png');const zero=await page.evaluate(async()=>{const {savePortraitPreset,PRESET_STORAGE_KEY}=await import('/src/portrait/presets.ts');const {ZERO_PORTRAIT_SETTINGS}=await import('/src/portrait/settings.ts');const saved=savePortraitPreset('Smart Zero Regression',ZERO_PORTRAIT_SETTINGS);dispatchEvent(new StorageEvent('storage',{key:PRESET_STORAGE_KEY}));return saved.find(p=>p.name==='Smart Zero Regression').id;});
 await batch.getByTestId('batch-preset').selectOption(`personal:${zero}`);await batch.getByTestId('batch-run').click();await idle();assert.deepEqual((await records()).find(row=>row.name==='smart-group.png'),before);
 await batch.getByTestId('batch-file-input').setInputFiles(png('white-no-face.png',variants.white));await chooseOnly('white-no-face.png');await batch.getByTestId('batch-preset').selectOption('smart:natural');await batch.getByTestId('batch-trial').click();await idle();
 const row=rows().filter({hasText:'white-no-face.png'});assert.equal(await row.getAttribute('data-status'),'skipped');assert.equal((await records()).length,3);
 await row.locator('.batch-row-main').click();await batch.getByTestId('batch-skipped-plan').locator('summary').click();assert.match(await batch.getByTestId('batch-skipped-plan').innerText(),/0 张脸/);
 return{retainedSmartResult:before.id};
});
await check('刷新恢复真实智能计划/实际曝光/每脸参数，390px计划可滚动查看',async()=>{
 const before=await records();await page.reload({waitUntil:'networkidle'});await open();assert.deepEqual(await records(),before);assert.equal(await rows().count(),3);
 await rows().filter({hasText:'smart-group.png'}).locator('.batch-row-main').click();await batch.getByTestId('batch-applied-plan').locator('summary').click();
 assert.equal(await batch.getByTestId('batch-compare').isDisabled(),true);
 await page.screenshot({path:path.join(output,'desktop-plan.png'),fullPage:true});await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await batch.getByTestId('batch-applied-plan').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'mobile-plan.png')});
});
assert.equal(modelCalls,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,checks,modelCalls,external,errors},null,2));console.log(`Intelligent batch passed: ${output}`);
}catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,external},null,2));throw error;}finally{await browser.close();}
