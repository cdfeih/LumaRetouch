/** App integration: local spot selection/eraser and late protection restore safety. No cloud calls. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const baseUrl=process.env.LUMA_TEST_URL||'http://127.0.0.1:5178',output=path.resolve('artifacts/point-retouch-selection');await mkdir(output,{recursive:true});
const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(30000);
const checks=[],errors=[],external=[];let cloudCalls=0;
page.on('pageerror',error=>errors.push(error.message));
await context.routeWebSocket('**/*',socket=>socket.close());
await context.route('**/*',route=>{const url=route.request().url();if(url.includes('/__native/request')){cloudCalls++;return route.abort();}if(url.startsWith(baseUrl)||/^(blob:|data:)/.test(url))return route.continue();external.push(url);return route.abort();});
async function check(name,action){const started=Date.now(),evidence=await action();checks.push({name,passed:true,elapsedMs:Date.now()-started,...evidence});console.log(`PASS ${name}`);}
const canvas=page.getByTestId('mask-canvas'),current=()=>page.locator('.working-image').getAttribute('src'),idle=()=>page.locator('.busy-overlay').waitFor({state:'hidden'});
const countAlpha=layer=>page.getByTestId(layer).evaluate(canvas=>{const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let total=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])total++;return total;});
try{
await page.goto(baseUrl,{waitUntil:'networkidle'});await page.waitForFunction(()=>!document.querySelector('.project-loading'));
const source=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d'),image=ctx.createImageData(640,480);for(let y=0;y<480;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4,g=((x*17+y*13)%11)-5;image.data.set(Math.hypot(x-320,y-240)<5?[195,52,48,255]:[155+g,116+g,99+g,255],i);}ctx.putImageData(image,0,0);return c.toDataURL();});
await page.getByTestId('photo-input').setInputFiles([{name:'selection-A.png',mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')},{name:'selection-B.png',mimeType:'image/png',buffer:Buffer.from(source.split(',')[1],'base64')}]);await page.locator('.working-image').waitFor();await idle();
await check('隐藏批量面板不阻止保护与浏览快捷键',async()=>{
  await page.keyboard.press('p');assert.match(await page.getByRole('button',{name:'保护画笔',exact:true}).getAttribute('class'),/protect-active/);
  await page.keyboard.press('h');assert.match(await page.getByRole('button',{name:'浏览照片',exact:true}).getAttribute('class'),/active/);
});
await page.getByTestId('tool-point').click();
const box=await canvas.boundingBox(),center={x:box.width/2,y:box.height/2};
await check('完全擦空点选后不执行本地修复，不接纳陈旧目标',async()=>{
  await canvas.click({position:center});assert.ok(await countAlpha('mask-canvas')>0);
  await page.getByRole('button',{name:'擦除选区',exact:true}).click();await canvas.click({position:center});assert.equal(await countAlpha('mask-canvas'),0);
  const before=await current();await page.getByRole('button',{name:'应用本地修补',exact:true}).click();await idle();assert.equal(await current(),before);
  assert.match(await page.locator('.toast').innerText(),/先点击/);
});
await check('部分擦除成为硬保护，本地点修只改剩余绿色范围',async()=>{
  await page.getByRole('button',{name:'选择修补位置',exact:true}).click();await canvas.click({position:center});
  await page.getByRole('button',{name:'擦除选区',exact:true}).click();await canvas.click({position:{x:center.x+12*box.width/640,y:center.y}});
  const count=await countAlpha('mask-canvas');assert.ok(count>0&&count<500);
  await canvas.evaluate(c=>{window.__spotSelection=c.getContext('2d').getImageData(0,0,c.width,c.height).data;});
  const before=await current();await page.getByRole('button',{name:'应用本地修补',exact:true}).click();await idle();const after=await current();
  const difference=await page.evaluate(async({before,after})=>{
    const read=async source=>{const image=new Image();image.src=source;await image.decode();const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,640,480).data;};
    const a=await read(before),b=await read(after);let inside=0,outside=0;for(let i=0;i<a.length;i+=4)if([0,1,2,3].some(k=>a[i+k]!==b[i+k])){if(window.__spotSelection[i+3])inside++;else outside++;}return{inside,outside,erasedCenterBefore:[...a.slice((240*640+320)*4,(240*640+320)*4+4)],erasedCenterAfter:[...b.slice((240*640+320)*4,(240*640+320)*4+4)]};
  },{before,after});
  assert.ok(difference.inside>0);assert.equal(difference.outside,0);assert.deepEqual(difference.erasedCenterAfter,difference.erasedCenterBefore);return difference;
});
await check('切回照片后清除保护层，迟到的旧解码不能让保护复活',async()=>{
  await page.getByTestId('tool-natural').click();await page.getByRole('button',{name:'保护画笔',exact:true}).click();await canvas.click({position:{x:100,y:100}});
  await page.getByRole('button',{name:'选择照片 selection-B.png',exact:true}).click();
  await page.evaluate(()=>{window.__originalDecode=HTMLImageElement.prototype.decode;window.__pendingDecodes=[];HTMLImageElement.prototype.decode=function(){const pending=window.__originalDecode.call(this);return this.src.startsWith('data:image/png')?pending.then(()=>new Promise(resolve=>window.__pendingDecodes.push(resolve))):pending;};});
  await page.getByRole('button',{name:'选择照片 selection-A.png',exact:true}).click();await page.waitForFunction(()=>window.__pendingDecodes.length>=2);
  await page.getByRole('button',{name:'保护画笔',exact:true}).click();await canvas.click({position:{x:200,y:100}});
  await page.getByRole('button',{name:'清除保护区',exact:true}).click();assert.equal(await countAlpha('protection-canvas'),0);
  await page.evaluate(()=>{HTMLImageElement.prototype.decode=window.__originalDecode;window.__pendingDecodes.splice(0).forEach(resolve=>resolve());});
  await page.waitForTimeout(75);const afterLateRestore=await countAlpha('protection-canvas');assert.equal(afterLateRestore,0);return{afterLateRestore};
});
assert.equal(cloudCalls,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,checks,cloudCalls,external,errors},null,2));console.log(`Spot selection integration passed: ${output}`);
}catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,external},null,2));throw error;}finally{await browser.close();}
