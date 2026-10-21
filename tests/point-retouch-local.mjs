/** Local sampled texture repair pixel acceptance, using only synthetic photos and an isolated browser. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const baseUrl = process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const output = path.resolve('artifacts/point-retouch-local'); await mkdir(output, { recursive: true });
const executablePath = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const page = await context.newPage(); page.setDefaultTimeout(45000);
const checks = [], errors = [], external = []; let cloudCalls = 0;
page.on('pageerror', error => errors.push(error.message));
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); }
  if (url.startsWith(baseUrl) || /^(data:|blob:)/.test(url)) return route.continue();
  external.push(url); return route.abort();
});
async function check(name, action) { const start = Date.now(), evidence = await action(); checks.push({ name, passed: true, elapsedMs: Date.now() - start, ...evidence }); console.log(`PASS ${name}`); }
try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const width=1920,height=1200,cx=900,cy=600,radius=16;
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d'),image=ctx.createImageData(width,height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const index=(y*width+x)*4,grain=((x*17+y*13)%11)-5;
      image.data.set(x>=1450?[22+grain,22+grain,22+grain,255]:[155+grain,116+grain,99+grain,x<4?0:x<10?128:255],index);
      if(Math.hypot(x-cx,y-cy)<=5)image.data.set([195,52,48,255],index);
    }
    ctx.putImageData(image,0,0);
    window.__pointPhoto={width,height,cx,cy,radius,source:canvas.toDataURL('image/png')};
    window.__pointDecode=async source=>{const bitmap=await createImageBitmap(await(await fetch(source)).blob());const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const context=c.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();return{pixels:context.getImageData(0,0,c.width,c.height).data,width:c.width,height:c.height};};
    window.__pointDiff=async result=>{const p=window.__pointPhoto,a=await window.__pointDecode(p.source),b=await window.__pointDecode(result);let inside=0,outside=0,alpha=0,semi=0;const values=new Set();for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){const i=(y*p.width+x)*4,changed=[0,1,2,3].some(k=>a.pixels[i+k]!==b.pixels[i+k]);if(changed)(Math.hypot(x-p.cx,y-p.cy)<p.radius?inside++:outside++);if(a.pixels[i+3]!==b.pixels[i+3])alpha++;if(a.pixels[i+3]<255&&changed)semi++;if(Math.hypot(x-p.cx,y-p.cy)<5)values.add(b.pixels[i+1]);}return{inside,outside,alpha,semi,textureValues:values.size,center:[...b.pixels.slice((p.cy*p.width+p.cx)*4,(p.cy*p.width+p.cx)*4+4)],dimensions:[b.width,b.height]};};
  });
  await check('1920×1200局部痘点改善、圆外逐像素不变、原纹理与透明边界保留', async () => {
    const evidence=await page.evaluate(async()=>{const {repairSpot}=await import('/src/point-retouch/index.ts');const p=window.__pointPhoto;const result=await repairSpot(p.source,{x:p.cx/p.width,y:p.cy/p.height,radius:p.radius/Math.min(p.width,p.height)});window.__pointAuto=result.dataUrl;return{changed:result.changed,warning:result.warning,...await window.__pointDiff(result.dataUrl)}});
    assert.equal(evidence.changed,true);assert.ok(evidence.inside>50);assert.equal(evidence.outside,0);assert.equal(evidence.alpha,0);assert.equal(evidence.semi,0);assert.ok(evidence.textureValues>4);assert.ok(evidence.center[1]>100);assert.deepEqual(evidence.dimensions,[1920,1200]);return evidence;
  });
  await check('低分辨率保护层alpha=1原样保留，完全保护不创建新成片', async () => {
    const evidence=await page.evaluate(async()=>{
      const {repairSpot}=await import('/src/point-retouch/index.ts');const p=window.__pointPhoto;
      const mask=document.createElement('canvas');mask.width=p.width/2;mask.height=p.height/2;const ctx=mask.getContext('2d'),pixel=ctx.createImageData(1,1);pixel.data.set([255,0,0,1]);ctx.putImageData(pixel,p.cx/2,p.cy/2);
      const result=await repairSpot(p.source,{x:p.cx/p.width,y:p.cy/p.height,radius:p.radius/Math.min(p.width,p.height),protection:mask});
      const a=await window.__pointDecode(p.source),b=await window.__pointDecode(result.dataUrl);let protectedChanged=0;
      for(let y=p.cy;y<p.cy+2;y++)for(let x=p.cx;x<p.cx+2;x++){const i=(y*p.width+x)*4;if([0,1,2,3].some(k=>a.pixels[i+k]!==b.pixels[i+k]))protectedChanged++;}
      ctx.fillStyle='rgba(255,0,0,0.004)';ctx.fillRect(0,0,mask.width,mask.height);
      const full=await repairSpot(p.source,{x:p.cx/p.width,y:p.cy/p.height,radius:p.radius/Math.min(p.width,p.height),protection:mask});
      return{changed:result.changed,protectedChanged,warning:result.warning,fullChanged:full.changed,sameSource:full.dataUrl===p.source};
    });
    assert.equal(evidence.changed,true);assert.equal(evidence.protectedChanged,0);assert.match(evidence.warning,/保护/);assert.equal(evidence.fullChanged,false);assert.equal(evidence.sameSource,true);return evidence;
  });
  await check('远距手动供样只读取两个小ROI，单笔圆外仍保持原像素', async () => {
    const evidence=await page.evaluate(async()=>{
      const {repairSpot}=await import('/src/point-retouch/index.ts');const p=window.__pointPhoto,original=CanvasRenderingContext2D.prototype.getImageData,reads=[];
      let result;
      CanvasRenderingContext2D.prototype.getImageData=function(x,y,w,h,...rest){reads.push({width:w,height:h});return original.call(this,x,y,w,h,...rest)};
      try{result=await repairSpot(p.source,{x:p.cx/p.width,y:p.cy/p.height,radius:p.radius/Math.min(p.width,p.height),sourcePoint:{x:250/p.width,y:220/p.height}});}finally{CanvasRenderingContext2D.prototype.getImageData=original;}
      return{changed:result.changed,reads,...await window.__pointDiff(result.dataUrl)};
    });
    assert.equal(evidence.changed,true);assert.equal(evidence.outside,0);assert.equal(evidence.reads.length,2);assert.ok(evidence.reads.every(read=>read.width*read.height<2500));return evidence;
  });
  await check('发际强边缘、透明边界及重叠供样拒绝，不涂糊结构', async () => {
    const evidence=await page.evaluate(async()=>{
      const {repairSpot}=await import('/src/point-retouch/index.ts');const p=window.__pointPhoto,results=[];
      for(const options of [{x:1450/p.width,y:.5,radius:p.radius/1200},{x:8/p.width,y:.5,radius:p.radius/1200},{x:p.cx/p.width,y:.5,radius:p.radius/1200,sourcePoint:{x:(p.cx+2)/p.width,y:.5}}]){const result=await repairSpot(p.source,options);results.push({changed:result.changed,sameSource:result.dataUrl===p.source,warning:result.warning});}return{results};
    });
    assert.ok(evidence.results.every(result=>!result.changed&&result.sameSource&&result.warning));return evidence;
  });
  await check('预取消及处理中取消均不接纳结果，非法坐标明确报错', async () => {
    const evidence=await page.evaluate(async()=>{
      const {repairSpot}=await import('/src/point-retouch/index.ts');const p=window.__pointPhoto,names=[];
      for(const pre of [true,false]){const controller=new AbortController();if(pre)controller.abort();const pending=repairSpot(p.source,{x:p.cx/p.width,y:.5,radius:p.radius/1200,signal:controller.signal});if(!pre)setTimeout(()=>controller.abort(),0);try{await pending;names.push('unexpected-success')}catch(error){names.push(error.name)}}
      let validation;try{await repairSpot(p.source,{x:2,y:.5,radius:.01})}catch(error){validation=error.message}return{names,validation};
    });
    assert.deepEqual(evidence.names,['AbortError','AbortError']);assert.match(evidence.validation,/坐标无效/);return evidence;
  });
  const images=await page.evaluate(()=>({before:window.__pointPhoto.source,after:window.__pointAuto}));
  await page.setContent(`<body style="background:#182016;color:#e1ebd8;font:16px sans-serif"><h2>本地纹理点修：合成皮肤痘点，100%局部</h2><div style="display:flex;gap:24px"><div><p>原图局部</p><canvas id="before" width="200" height="160"></canvas></div><div><p>修复局部</p><canvas id="after" width="200" height="160"></canvas></div></div><p>邻域取样、色差匹配、圆内羽化；不调用模型。</p></body>`);
  await page.evaluate(async({before,after})=>{for(const[id,source]of[['before',before],['after',after]]){const image=new Image();image.src=source;await image.decode();document.getElementById(id).getContext('2d').drawImage(image,800,520,200,160,0,0,200,160)}},images);
  await page.screenshot({path:path.join(output,'local-texture-repair.png')});
  assert.equal(cloudCalls,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,checks,cloudCalls,external,errors},null,2));console.log(`Local spot repair passed: ${output}`);
}catch(error){await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,errors,external},null,2));throw error;}finally{await browser.close();}
