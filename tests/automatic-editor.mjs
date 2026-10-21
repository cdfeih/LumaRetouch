/** Real App automatic/manual/history/project/scope acceptance using a public portrait; no paid model. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const baseUrl=process.env.LUMA_TEST_URL||'http://127.0.0.1:5178',output=path.resolve('artifacts/automatic-editor');await mkdir(output,{recursive:true});
const executablePath=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(60000);
const checks=[],errors=[],external=[];let modelCalls=0;
page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss());
await context.routeWebSocket('**/*',socket=>socket.close());
await context.route('**/*',route=>{const url=route.request().url();if(url.includes('/__native/request')){modelCalls++;return route.abort();}if(url.startsWith(baseUrl)||/^(data:|blob:)/.test(url))return route.continue();external.push(url);return route.abort();});
async function check(name,action){const start=Date.now(),evidence=await action();checks.push({name,passed:true,elapsedMs:Date.now()-start,...evidence});console.log(`PASS ${name}`);}
async function idle(){await page.locator('.busy-overlay').waitFor({state:'hidden'});await page.waitForFunction(()=>{const image=document.querySelector('.working-image');return image instanceof HTMLImageElement&&image.complete&&image.naturalWidth>0;});}
async function current(){await idle();return page.locator('.working-image').getAttribute('src');}
async function smart(){await page.getByTestId('automatic-run').click();await idle();assert.doesNotMatch(await page.locator('.toast').innerText(),/正在恢复|失败|已取消/);}
async function manual(){await page.getByRole('button',{name:'应用当前人像参数',exact:true}).click();await idle();}
async function saved(){await page.waitForFunction(()=>document.querySelector('.project-status')?.classList.contains('saved'));}
async function difference(before,after,scope=false){return page.evaluate(async({before,after,scope})=>{
 const decode=async source=>{const image=new Image();image.src=source;await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return{pixels:ctx.getImageData(0,0,c.width,c.height).data,width:c.width,height:c.height};};
 const a=await decode(before),b=await decode(after);if(a.width!==b.width||a.height!==b.height)throw new Error('Photo dimensions changed');let total=0,protectedChanged=0,outsideChanged=0,protectedCount=0,selectionCount=0;
 const mask=scope?window.__automaticScope:null;
 for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const i=(y*a.width+x)*4,changed=[0,1,2,3].some(k=>a.pixels[i+k]!==b.pixels[i+k]);if(changed)total++;if(mask){const p=(Math.floor(y/a.height*mask.height)*mask.width+Math.floor(x/a.width*mask.width))*4;if(mask.red[p+3]){protectedCount++;if(changed)protectedChanged++;}if(mask.green[p+3])selectionCount++;else if(changed)outsideChanged++;}}
 return{total,protectedChanged,outsideChanged,protectedCount,selectionCount};
},{before,after,scope});}
async function captureScope(){await page.evaluate(()=>{const red=document.querySelector('[data-testid="protection-canvas"]'),green=document.querySelector('[data-testid="mask-canvas"]');window.__automaticScope={width:red.width,height:red.height,red:red.getContext('2d').getImageData(0,0,red.width,red.height).data,green:green.getContext('2d').getImageData(0,0,green.width,green.height).data};});}
async function clickPhoto(x,y){const canvas=page.getByTestId('mask-canvas'),box=await canvas.boundingBox();await canvas.click({position:{x:x*box.width,y:y*box.height}});}
let original,first,bright,face;
try{
await page.goto(baseUrl,{waitUntil:'networkidle'});await page.locator('.project-loading-overlay').waitFor({state:'hidden'});
await page.getByTestId('photo-input').setInputFiles({name:'automatic-public-portrait.jpg',mimeType:'image/jpeg',buffer:await readFile('tests/fixtures/mediapipe-portrait.jpg')});await idle();await page.getByTestId('tool-natural').click();original=await current();
await check('真实智能按钮完成分析，重复运行与底部当前参数同参均不叠加',async()=>{
 await smart();first=await current();const initial=await difference(original,first);assert.ok(initial.total>100);await page.getByTestId('automatic-report').waitFor();
 const values=await page.locator('.portrait-settings input[type="range"]').evaluateAll(inputs=>Object.fromEntries(inputs.map(input=>[input.getAttribute('aria-label'),input.value])));
 await smart();const repeated=await difference(first,await current());assert.equal(repeated.total,0);
 await manual();const manualDifference=await difference(first,await current());assert.equal(manualDifference.total,0);
 return{initiallyChanged:initial.total,repeatedChanged:repeated.total,manualChanged:manualDifference.total,parameters:values};
});
await check('撤销重做恢复智能计划，工程刷新后可同参续修且没有二次磨皮',async()=>{
 await page.getByRole('button',{name:'撤销编辑',exact:true}).click();assert.equal((await difference(original,await current())).total,0);
 await page.getByRole('button',{name:'重做编辑',exact:true}).click();assert.equal((await difference(first,await current())).total,0);await page.getByTestId('automatic-report').waitFor();
 await saved();await page.reload({waitUntil:'networkidle'});await page.locator('.project-loading-overlay').waitFor({state:'hidden'});await idle();await page.waitForTimeout(150);
 assert.equal((await difference(first,await current())).total,0);await page.getByTestId('automatic-report').waitFor();
 await smart();const repeat=await difference(first,await current());assert.equal(repeat.total,0);await manual();assert.equal((await difference(first,await current())).total,0);
 return{resumedChanged:repeat.total};
});
await check('重新选择智能通透可执行并同步实际人物参数',async()=>{
 await page.getByRole('button',{name:'人像通透',exact:true}).click();await smart();bright=await current();assert.match(await page.getByTestId('automatic-report').innerText(),/智能通透/);
 face=await page.evaluate(async source=>(await(await import('/src/portrait/detection.ts')).detectPortraitFaces(source))[0],bright);assert.ok(face);
 await saved();const state=await page.evaluate(async()=>{const draft=await(await import('/src/editor/project.ts')).loadProjectDraft();const doc=draft.documents.find(item=>item.id===draft.activeId);return{profile:doc.automatic.profile,faces:doc.automatic.faces.length};});assert.equal(state.profile,'bright');return state;
});
await check('智能完成后新增红保护，再次智能保留当前红区像素并重建固定底图',async()=>{
 const target=await page.evaluate(async({original,bright,bounds})=>{const decode=async source=>{const image=new Image();image.src=source;await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return{p:ctx.getImageData(0,0,c.width,c.height).data,w:c.width,h:c.height};};const a=await decode(original),b=await decode(bright);let best={x:0,y:0,d:0};for(let y=Math.floor(bounds.y*a.h);y<(bounds.y+bounds.height)*a.h;y++)for(let x=Math.floor(bounds.x*a.w);x<(bounds.x+bounds.width)*a.w;x++){const i=(y*a.w+x)*4,d=Math.abs(a.p[i]-b.p[i])+Math.abs(a.p[i+1]-b.p[i+1])+Math.abs(a.p[i+2]-b.p[i+2]);if(d>best.d)best={x:x/a.w,y:y/a.h,d};}return best;},{original,bright,bounds:face.bounds});assert.ok(target.d>0);
 await page.getByRole('slider',{name:'画笔大小',exact:true}).fill('12');await page.getByRole('button',{name:'保护画笔',exact:true}).click();await clickPhoto(target.x,target.y);await captureScope();
 const before=await current();await smart();const delta=await difference(before,await current(),true);assert.ok(delta.protectedCount>0);assert.equal(delta.protectedChanged,0);
 await saved();const rebased=await page.evaluate(async before=>{const draft=await(await import('/src/editor/project.ts')).loadProjectDraft();return draft.documents.find(item=>item.id===draft.activeId).automatic.baseline===before;},before);assert.equal(rebased,true);
 const accepted=await current();await smart();assert.equal((await difference(accepted,await current())).total,0);return{...delta,reconstructedFromCurrent:rebased};
});
await check('新增绿色局部范围再选保纹理，圈外已有修饰和红区保持当前像素',async()=>{
 const before=await current();const image=await page.locator('.working-image').evaluate(img=>({width:img.naturalWidth,display:img.getBoundingClientRect().width}));
 const radiusOriginal=face.bounds.width*image.width*.4;const size=Math.max(12,Math.min(150,Math.round(radiusOriginal*2*image.display/image.width)));
 await page.getByRole('slider',{name:'画笔大小',exact:true}).fill(String(size));await page.getByRole('button',{name:'画笔',exact:true}).click();await clickPhoto(face.bounds.x+face.bounds.width*.25,face.bounds.y+face.bounds.height*.64);await captureScope();
 const prior=await difference(original,before,true);assert.ok(prior.outsideChanged>0,'The outside already contains retouching that would expose a wrong old baseline');
 await page.getByRole('button',{name:'保纹理精修',exact:true}).click();await smart();const after=await current(),delta=await difference(before,after,true);assert.ok(delta.selectionCount>0);assert.equal(delta.outsideChanged,0);assert.equal(delta.protectedChanged,0);
 await saved();const rebased=await page.evaluate(async before=>{const draft=await(await import('/src/editor/project.ts')).loadProjectDraft();const state=draft.documents.find(item=>item.id===draft.activeId).automatic;return{rebased:state.baseline===before,profile:state.profile};},before);assert.equal(rebased.rebased,true);assert.equal(rebased.profile,'texture');
 await manual();assert.equal((await difference(after,await current())).total,0);
 await page.getByTestId('automatic-report').getByText('查看逐人物参数',{exact:true}).click();await page.screenshot({path:path.join(output,'desktop-editor.png'),fullPage:true});return{...delta,previousOutsideRetouch:prior.outsideChanged,...rebased};
});
await check('明确alpha128绿色与alpha1红保护下智能完成再按当前人物参数手动应用保持0差',async()=>{
 await page.locator('.mask-actions').getByRole('button',{name:'清除',exact:true}).click();await page.getByRole('button',{name:'画笔',exact:true}).click();
 const box=await page.getByTestId('mask-canvas').boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.35);await page.mouse.down();
 await page.getByTestId('mask-canvas').evaluate((canvas,bounds)=>{const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);const x=Math.max(0,Math.floor(bounds.x*canvas.width)),y=Math.max(0,Math.floor(bounds.y*canvas.height)),width=Math.min(canvas.width-x,Math.ceil(bounds.width*canvas.width)),height=Math.min(canvas.height-y,Math.ceil(bounds.height*canvas.height));const image=ctx.createImageData(width,height);for(let i=0;i<image.data.length;i+=4)image.data.set([255,255,255,128],i);ctx.putImageData(image,x,y);const red=document.querySelector('[data-testid="protection-canvas"]'),rx=Math.floor((bounds.x+bounds.width*.75)*red.width),ry=Math.floor((bounds.y+bounds.height*.6)*red.height),rc=red.getContext('2d'),pixel=rc.createImageData(1,1);pixel.data.set([255,0,0,1]);rc.putImageData(pixel,rx,ry);window.__automaticAlphaOne={x:rx,y:ry};},face.bounds);
 await page.mouse.up();const alphaValues=await page.getByTestId('mask-canvas').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,values=new Set();for(let i=3;i<data.length;i+=4)if(data[i])values.add(data[i]);return[...values]});assert.deepEqual(alphaValues,[128]);
 await captureScope();const beforeSmart=await current();await smart();const automatic=await current(),protection=await difference(beforeSmart,automatic,true);assert.equal(protection.protectedChanged,0);
 const redAlpha=await page.getByTestId('protection-canvas').evaluate(canvas=>canvas.getContext('2d').getImageData(window.__automaticAlphaOne.x,window.__automaticAlphaOne.y,1,1).data[3]);assert.equal(redAlpha,1);
 await manual();const delta=await difference(automatic,await current());assert.equal(delta.total,0);return{alphaValues,redAlpha,protectedChanged:protection.protectedChanged,...delta};
});
assert.equal(modelCalls,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,checks,modelCalls,external,errors},null,2));console.log(`Automatic editor passed: ${output}`);
}catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,external},null,2));throw error;}finally{await browser.close();}
