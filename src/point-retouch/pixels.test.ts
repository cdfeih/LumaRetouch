import { describe, expect, it } from 'vitest';
import { repairSpotPixels } from './pixels';

function skin(width = 160, height = 120) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, grain = ((x * 17 + y * 13) % 11) - 5;
    pixels.set([155 + grain, 116 + grain, 99 + grain, 255], i);
  }
  return { pixels, width, height };
}
function dot(pixels: Uint8ClampedArray, width: number, cx: number, cy: number, radius = 3) {
  for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) {
    if (Math.hypot(x-cx,y-cy) <= radius) pixels.set([195, 52, 48, 255], (y * width + x) * 4);
  }
}
const pixel = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => [...pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe('local sampled texture spot repair', () => {
  it('repairs a small red blemish with nearby grain and never changes outside the circular brush', async () => {
    const { pixels, width, height } = skin(); dot(pixels, width, 80, 60);
    const input = new Uint8ClampedArray(pixels);
    const result = await repairSpotPixels(pixels, width, height, { x:80,y:60,radius:9 });
    expect(result.changedPixels).toBeGreaterThan(20); expect(result.sourcePoint).toBeDefined();
    expect(pixel(result.pixels,width,80,60)[1]).toBeGreaterThan(100);
    expect(pixels).toEqual(input);
    let changedOutside = 0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(Math.hypot(x-80,y-60)>=9&&pixel(result.pixels,width,x,y).some((value,i)=>value!==pixel(pixels,width,x,y)[i]))changedOutside++;
    expect(changedOutside).toBe(0);
    const innerValues=[];for(let y=57;y<=63;y++)for(let x=77;x<=83;x++)innerValues.push(result.pixels[(y*width+x)*4+1]);
    expect(new Set(innerValues).size).toBeGreaterThan(4); // Texture is transferred, not painted with a flat mean.
  });
  it('uses an explicit clean sample with feathered boundaries', async () => {
    const {pixels,width,height}=skin();dot(pixels,width,40,60);
    const result=await repairSpotPixels(pixels,width,height,{x:40,y:60,radius:9,sourcePoint:{x:100,y:60}});
    expect(result.changedPixels).toBeGreaterThan(0);expect(result.sourcePoint).toEqual({x:100,y:60});
    expect(pixel(result.pixels,width,40,60)[1]).toBeGreaterThan(100);
    expect(pixel(result.pixels,width,49,60)).toEqual(pixel(pixels,width,49,60));
    expect(Math.abs(pixel(result.pixels,width,48,60)[1]-pixel(pixels,width,48,60)[1])).toBeLessThanOrEqual(2);
  });
  it('does not choose a dirty red donor merely because its luminance matches clean skin', async () => {
    const {pixels,width,height}=skin();dot(pixels,width,80,60);
    const first=await repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9});
    const point=first.sourcePoint!;
    pixels.set([250,92,90,255],(Math.round(point.y)*width+Math.round(point.x))*4);
    const next=await repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9});
    expect(next.sourcePoint).not.toEqual(point);expect(pixel(next.pixels,width,80,60)[0]).toBeLessThan(180);
  });
  it('locks alpha=1 protection and reports an entirely protected target as unchanged', async () => {
    const {pixels,width,height}=skin();dot(pixels,width,80,60);
    const alpha=new Uint8Array(width*height);alpha[60*width+80]=1;
    const partial=await repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9,protectionAlpha:alpha});
    expect(partial.changedPixels).toBeGreaterThan(0);expect(pixel(partial.pixels,width,80,60)).toEqual(pixel(pixels,width,80,60));
    expect(partial.warning).toContain('保护');
    alpha.fill(1);
    const full=await repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9,protectionAlpha:alpha});
    expect(full.changedPixels).toBe(0);expect(full.pixels).toBe(pixels);expect(full.warning).toContain('保护');
  });
  it('refuses strong hair/skin-like boundaries rather than smearing across them', async () => {
    const {pixels,width,height}=skin();
    for(let y=0;y<height;y++)for(let x=80;x<width;x++)pixels.set([20,20,20,255],(y*width+x)*4);
    const result=await repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9});
    expect(result.changedPixels).toBe(0);expect(result.pixels).toBe(pixels);expect(result.warning).toContain('边缘');
  });
  it('preserves alpha and every semitransparent pixel and refuses transparent boundaries', async () => {
    const {pixels,width,height}=skin();dot(pixels,width,80,60);
    pixels[(60*width+80)*4+3]=128;
    const result=await repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9});
    expect(result.changedPixels).toBeGreaterThan(0);expect(pixel(result.pixels,width,80,60)).toEqual(pixel(pixels,width,80,60));
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)expect(result.pixels[(y*width+x)*4+3]).toBe(pixels[(y*width+x)*4+3]);
    const edge=await repairSpotPixels(pixels,width,height,{x:3,y:3,radius:9});expect(edge.changedPixels).toBe(0);expect(edge.warning).toContain('边界');
  });
  it('rejects overlapping or incompatible samples without modifying the source', async () => {
    const {pixels,width,height}=skin();dot(pixels,width,40,60);
    expect((await repairSpotPixels(pixels,width,height,{x:40,y:60,radius:9,sourcePoint:{x:42,y:60}})).changedPixels).toBe(0);
    const incompatible=skin();incompatible.pixels.fill(255);
    const result=await repairSpotPixels(pixels,width,height,{x:40,y:60,radius:9,sourcePoint:{x:100,y:60},donorImage:{...incompatible,x:80,y:60}});
    expect(result.changedPixels).toBe(0);expect(result.warning).toContain('色差');
  });
  it('accepts two separate tiny ROIs for a far-away manual sample', async () => {
    const target=skin(40,40);dot(target.pixels,40,20,20,2);const donor=skin(40,40);
    const result=await repairSpotPixels(target.pixels,40,40,{x:20,y:20,radius:7,sourcePoint:{x:3000,y:1000},donorImage:{...donor,x:20,y:20}});
    expect(result.changedPixels).toBeGreaterThan(0);expect(pixel(result.pixels,40,20,20)[1]).toBeGreaterThan(100);
  });
  it('cancels before processing or during an asynchronous stroke and leaves caller buffers intact', async () => {
    const {pixels,width,height}=skin(),original=new Uint8ClampedArray(pixels);
    const pre=new AbortController();pre.abort();
    await expect(repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9,signal:pre.signal})).rejects.toMatchObject({name:'AbortError'});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),0);
    try{await expect(repairSpotPixels(pixels,width,height,{x:80,y:60,radius:9,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});}finally{clearTimeout(timer);}
    expect(pixels).toEqual(original);
  });
  it('validates dimensions, protection sizes and brush bounds', async () => {
    const {pixels,width,height}=skin();
    for(const options of [{x:-1,y:60,radius:9},{x:80,y:60,radius:0},{x:80,y:60,radius:193},{x:80,y:60,radius:9,protectionAlpha:new Uint8Array(2)}])await expect(repairSpotPixels(pixels,width,height,options)).rejects.toThrow('无效');
  });
});
