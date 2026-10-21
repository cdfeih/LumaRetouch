/** Actual adaptive plan + local render on public portrait pixels. Own port 0
 * server and browser; image services and all external requests are blocked. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
let server, browser, page, failure;
const report = { passed: false }, external = [], errors = [], models = new Set(); let cloudCalls = 0;
await mkdir('artifacts/automatic-retouch', { recursive: true });
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, clearScreen: false }); await server.listen();
  const address = server.httpServer.address(); assert.ok(address && typeof address === 'object' && address.port !== 5178);
  const base = `http://127.0.0.1:${address.port}`; report.port = address.port;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }); const context = await browser.newContext();
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => { const url = route.request().url(); if (url.includes('/__native/request')) { cloudCalls++; return route.abort(); } if (/\/models\/.*\.(task|tflite|wasm)(?:\?|$)/.test(url)) models.add(url); return url.startsWith(base) || /^(data:|blob:)/.test(url) ? route.continue() : (external.push(url), route.abort()); });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(base);
  const fixture = `data:image/jpeg;base64,${(await readFile('tests/fixtures/mediapipe-portrait.jpg')).toString('base64')}`;
  const evidence = await page.evaluate(async fixture => {
    const { planAutomaticRetouch } = await import('/src/portrait/auto-retouch.ts');
    const { renderAutomaticRetouch } = await import('/src/portrait/auto-render.ts');
    const { createFaceSkinMask } = await import('/src/portrait/detection.ts');
    const { DEFAULT_ADJUSTMENTS } = await import('/src/imaging/index.ts');
    const { adjustPixelBuffer } = await import('/src/imaging/pixels.ts');
    const { SHAPE_FIELDS } = await import('/src/portrait/settings.ts');
    const image = new Image(); image.src = fixture; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width * 2; c.height = image.height; const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0); ctx.drawImage(image, image.width, 0);
    const darker = ctx.getImageData(image.width, 0, image.width, image.height); adjustPixelBuffer(darker.data, { ...DEFAULT_ADJUSTMENTS, exposure: -.7 }, darker.data); ctx.putImageData(darker, image.width, 0);
    const source = c.toDataURL('image/png');
    const decode = async data => { const im = new Image(); im.src = data; await im.decode(); const t = document.createElement('canvas'); t.width = im.width; t.height = im.height; const x = t.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0); const pixels = x.getImageData(0, 0, t.width, t.height).data; t.width = t.height = 1; return pixels; };
    const difference = (a,b) => { let changed=0,max=0; for (let p=0;p<a.length;p+=4) { let flag=false; for(let k=0;k<4;k++){const d=Math.abs(a[p+k]-b[p+k]);if(d)flag=true;max=Math.max(max,d);} if(flag)changed++; } return {changed,max}; };
    const rendered = await renderAutomaticRetouch(source, { profile: 'natural' }), plan = rendered.plan;
    const texture = await planAutomaticRetouch(source, { profile: 'texture' });
    const bright = await planAutomaticRetouch(source, { profile: 'bright' });
    const skinBaseline = rendered.skinBaseline, result = rendered.image;
    const repeated = (await renderAutomaticRetouch(source, { profile: 'natural' })).image;
    const sourcePixels=await decode(source), baselinePixels=await decode(skinBaseline), outputPixels=await decode(result), repeatedPixels=await decode(repeated);
    const masks = plan.faces.map(face => createFaceSkinMask(face,c.width,c.height)); let outsideSkinChanged=0;
    for(let p=0;p<c.width*c.height;p++)if(masks.every(mask=>!mask[p])&&[0,1,2,3].some(k=>outputPixels[p*4+k]!==baselinePixels[p*4+k]))outsideSkinChanged++;
    const protection=document.createElement('canvas');protection.width=c.width;protection.height=c.height;const pc=protection.getContext('2d');pc.fillStyle='rgba(255,0,0,0.004)';pc.fillRect(0,0,image.width,c.height);
    const protectedRun=await renderAutomaticRetouch(source,{profile:'natural',protection}),protectedPlan=protectedRun.plan;
    const protectedPixels=await decode(protectedRun.image);let redChanged=0,rightChanged=0;
    for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;const changed=[0,1,2,3].some(k=>sourcePixels[i+k]!==protectedPixels[i+k]);if(changed){if(x<image.width)redChanged++;else rightChanged++;}}
    const selection=document.createElement('canvas');selection.width=c.width;selection.height=c.height;const sc=selection.getContext('2d');sc.fillStyle='rgba(0,255,0,.5)';sc.fillRect(image.width,0,image.width,c.height);
    const selectedRun=await renderAutomaticRetouch(source,{profile:'natural',selection}),selectedPlan=selectedRun.plan;
    const selectedPixels=await decode(selectedRun.image);let greenOutsideChanged=0,greenInsideChanged=0;
    for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if([0,1,2,3].some(k=>sourcePixels[i+k]!==selectedPixels[i+k])){if(x<image.width)greenOutsideChanged++;else greenInsideChanged++;}}
    const cancelled=new AbortController();cancelled.abort();let cancellation='';try{await planAutomaticRetouch(source,{profile:'natural',signal:cancelled.signal});}catch(error){cancellation=error.name;}
    const during=new AbortController();let lateCancellation='',lateReturned=false;try{await renderAutomaticRetouch(source,{profile:'natural',signal:during.signal,onProgress:label=>{if(label.includes('按人物'))during.abort();}});lateReturned=true;}catch(error){lateCancellation=error.name;}
    const settings=plan.subjects.map(subject=>({face:subject.face.label,settings:subject.settings,statistics:subject.statistics}));
    const forbidden=plan.subjects.flatMap(subject=>[...SHAPE_FIELDS,'darkCircles','teethWhitening','eyeWhitening','lipColor'].filter(key=>subject.settings[key]!==0));
    return { faceCount:plan.faces.length,exposure:plan.exposure,settings,summary:plan.summary,warnings:plan.warnings,
      profiles:{natural:plan.subjects.map(s=>s.settings),texture:texture.subjects.map(s=>s.settings),bright:bright.subjects.map(s=>s.settings)},
      imageDifference:difference(sourcePixels,outputPixels),repeatDifference:difference(outputPixels,repeatedPixels),outsideSkinChanged,forbidden,
      protection:{exposure:protectedPlan.exposure,firstSettings:protectedPlan.subjects[0]?.settings,firstReliable:protectedPlan.subjects[0]?.statistics.reliable,redChanged,rightChanged},
      selection:{exposure:selectedPlan.exposure,firstSettings:selectedPlan.subjects[0]?.settings,greenOutsideChanged,greenInsideChanged},cancellation,lateCancellation,lateReturned };
  },fixture);
  Object.assign(report,evidence);
  assert.equal(evidence.faceCount,2); assert.ok(evidence.settings.every(s=>s.statistics.reliable),JSON.stringify(evidence.settings));
  assert.notDeepEqual(evidence.settings[0].settings,evidence.settings[1].settings,'different actual lighting must not receive one identical preset');
  assert.equal(evidence.exposure,0,'natural mode must not lift an already adequately exposed face just because its background is dark');
  assert.ok(evidence.profiles.texture.every(settings=>settings.smoothing===0),'texture mode keeps ordinary smoothing off');
  assert.ok(evidence.settings[0].statistics.medianLuminance>evidence.settings[1].statistics.medianLuminance+10);
  assert.ok(evidence.imageDifference.changed>100);assert.equal(evidence.repeatDifference.changed,0);assert.equal(evidence.outsideSkinChanged,0);assert.deepEqual(evidence.forbidden,[]);
  assert.equal(evidence.protection.exposure,0);assert.equal(evidence.protection.firstReliable,false);assert.ok(Object.values(evidence.protection.firstSettings).every(n=>n===0));assert.equal(evidence.protection.redChanged,0);assert.ok(evidence.protection.rightChanged>100);
  assert.equal(evidence.selection.exposure,0);assert.ok(Object.values(evidence.selection.firstSettings).every(n=>n===0));assert.equal(evidence.selection.greenOutsideChanged,0);assert.ok(evidence.selection.greenInsideChanged>100);assert.equal(evidence.cancellation,'AbortError');assert.equal(evidence.lateCancellation,'AbortError');assert.equal(evidence.lateReturned,false);
  // A fresh module/model context is necessary; the success context has already
  // cached its segmenter. A missing model must reject before producing even an
  // exposure-only partial result, and removing the failed route must allow retry.
  const brokenContext=await browser.newContext();let modelFailures=0,blockSemantic=true;
  await brokenContext.routeWebSocket('**/*',socket=>socket.close());
  await brokenContext.route('**/*',route=>{const url=route.request().url();if(url.includes('/__native/request')){cloudCalls++;return route.abort();}if(url.includes('/models/selfie_multiclass_256x256.tflite')&&blockSemantic){modelFailures++;return route.abort();}return url.startsWith(base)||/^(data:|blob:)/.test(url)?route.continue():(external.push(url),route.abort());});
  const brokenPage=await brokenContext.newPage();brokenPage.on('pageerror',error=>errors.push(error.message));await brokenPage.goto(base);
  report.modelFailure=await brokenPage.evaluate(async fixture=>{const {renderAutomaticRetouch}=await import('/src/portrait/auto-render.ts');let returned=false,message='';try{await renderAutomaticRetouch(fixture,{profile:'bright'});returned=true;}catch(error){message=error.message;}return {returned,message};},fixture);
  report.modelFailure.requests=modelFailures;assert.ok(modelFailures>0);assert.equal(report.modelFailure.returned,false);assert.match(report.modelFailure.message,/本地皮肤分割模型加载失败/);
  blockSemantic=false;
  report.modelFailure.retry=await brokenPage.evaluate(async fixture=>{const {renderAutomaticRetouch}=await import('/src/portrait/auto-render.ts');const result=await renderAutomaticRetouch(fixture,{profile:'natural'});return {faceCount:result.plan.faces.length,validImage:result.image.startsWith('data:image/'),reliable:result.plan.subjects.some(subject=>subject.statistics.reliable)};},fixture);
  assert.ok(report.modelFailure.retry.faceCount>0);assert.equal(report.modelFailure.retry.validImage,true);assert.equal(report.modelFailure.retry.reliable,true);await brokenContext.close();
  assert.ok([...models].some(url=>url.includes('selfie_multiclass_256x256.tflite')));assert.equal(cloudCalls,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);report.passed=true;
} catch(error) { failure=error;report.failure={message:error.message,stack:error.stack};await page?.screenshot({path:'artifacts/automatic-retouch/failure.png',fullPage:true}).catch(()=>{}); }
finally { await browser?.close();await server?.close();Object.assign(report,{serverClosed:!server?.httpServer?.listening,models:[...models],cloudCalls,external,errors});await writeFile('artifacts/automatic-retouch/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2)); }
if(failure)throw failure;
