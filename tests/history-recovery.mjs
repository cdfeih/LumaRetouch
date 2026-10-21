/** Cross-tool undo must restore the original portrait processing baseline. */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const base=process.env.LUMA_TEST_URL || 'http://127.0.0.1:5178';
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
let blocked=[];
await context.route('**/*',route=>{const u=route.request().url();return u.startsWith(base)||u.startsWith('data:')||u.startsWith('blob:')?route.continue():(blocked.push(u),route.abort());});
await context.routeWebSocket('**/*',socket=>socket.close());
const page=await context.newPage();page.setDefaultTimeout(90000);page.on('dialog',d=>d.accept());
try {
await page.goto(base);
const input=page.getByTestId('photo-input');
await input.setInputFiles({name:'public.jpg',mimeType:'image/jpeg',buffer:await readFile('tests/fixtures/mediapipe-portrait.jpg')});
const settled=async()=>{await page.locator('.busy-overlay').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('.working-image')?.complete);};
const current=async()=>{await settled();return page.locator('.working-image').getAttribute('src');};
const apply=async()=>{await page.getByRole('button',{name:'开始一键自然精修',exact:true}).click();await settled();};
await settled();await page.getByTestId('tool-natural').click();
await page.getByRole('button',{name:'全部归零',exact:true}).click();
await page.getByRole('slider',{name:'肤色提亮',exact:true}).fill('100');await apply();
const first=await current();
await apply();const repeated=await current();
await page.getByRole('button',{name:'基础调色',exact:false}).click();
await page.getByRole('slider',{name:'曝光',exact:true}).fill('0.5');
await page.getByRole('button',{name:'应用调色',exact:true}).click();await settled();
await page.getByRole('button',{name:'撤销编辑',exact:true}).click();await settled();
const undone=await current();
await apply();const afterUndoApply=await current();
const diff=await page.evaluate(async({first,repeated,undone,afterUndoApply})=>{
 const decode=async s=>{const im=new Image();im.src=s;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const x=c.getContext('2d');x.drawImage(im,0,0);return x.getImageData(0,0,c.width,c.height).data;};
 const a=await decode(first),b=await decode(repeated),c=await decode(undone),d=await decode(afterUndoApply);
 const compare=z=>{let pixels=0,total=0,max=0;for(let i=0;i<a.length;i+=4){let ch=false;for(let k=0;k<3;k++){const v=Math.abs(z[i+k]-a[i+k]);if(v)ch=true;total+=v;max=Math.max(max,v);}if(ch)pixels++;}return{pixels,total,max};};return {repeat:compare(b),undo:compare(c),reapplyAfterUndo:compare(d)};
},{first,repeated,undone,afterUndoApply});
const lightSlider=await page.getByRole('slider',{name:'肤色提亮',exact:true}).inputValue();
await mkdir('artifacts/history-recovery',{recursive:true});
await writeFile('artifacts/history-recovery/report.json',JSON.stringify({diff,lightSlider,blocked},null,2));
if(diff.reapplyAfterUndo.pixels!==0) throw new Error('Cross-tool undo must restore portrait baseline'); console.log(JSON.stringify({diff,lightSlider,blocked}));
// Dismissing a close prompt keeps the unexported image and its history.
let prompted=false;page.removeAllListeners('dialog');page.on('dialog',async d=>{prompted=true;await d.dismiss()});
await page.getByRole('button',{name:'移除照片 public.jpg',exact:true}).click();
if(!prompted || await page.locator('.thumbnail-select').count()!==1) throw new Error('Unexported close must be cancellable');
} finally { await browser.close(); }
