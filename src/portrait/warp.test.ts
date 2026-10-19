import { describe,expect,it } from 'vitest'
import { createPortraitWarpPlan,DEFAULT_SHAPE_SETTINGS,mergePortraitWarpStrip,normalizeShapeSettings,portraitWarpOffset } from './warp'
import type { PortraitWarpSubject,ShapeSettings } from './warp'
import type { PortraitFace,PortraitPoint } from './detection'
import type { PortraitBody } from './body'

const OVAL=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
const FEATURES=[
  [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],
  [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466],
  [70,63,105,66,107,55,65,52,53,46],[300,293,334,296,336,285,295,282,283,276],
  [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185],
  [1,2,4,5,6,19,94,97,98,168,195,197,326,327],
]
function face():PortraitFace{
  const landmarks:PortraitPoint[]=Array.from({length:478},()=>({x:0.5,y:0.32}))
  OVAL.forEach((index,i)=>{const angle=i/OVAL.length*Math.PI*2;landmarks[index]={x:0.5+Math.sin(angle)*0.2,y:0.3-Math.cos(angle)*0.25}})
  const centers=[[0.43,0.24],[0.57,0.24],[0.43,0.19],[0.57,0.19],[0.5,0.4],[0.5,0.32]]
  FEATURES.forEach((indices,group)=>indices.forEach((index,i)=>{const angle=i/indices.length*Math.PI*2;landmarks[index]={x:centers[group][0]+Math.cos(angle)*(group===5?0.023:0.035),y:centers[group][1]+Math.sin(angle)*0.012}}))
  return {id:'face-1',label:'人物 1',bounds:{x:0.3,y:0.05,width:0.4,height:0.5},landmarks,thumbnail:''}
}
function body():PortraitBody{
  const landmarks=Array.from({length:33},()=>({x:0.5,y:0.4,visibility:1}))
  for(const [index,x,y]of [[11,0.36,0.28],[12,0.64,0.28],[13,0.28,0.48],[14,0.72,0.48],[15,0.22,0.65],[16,0.78,0.65],[23,0.41,0.57],[24,0.59,0.57],[25,0.40,0.76],[26,0.60,0.76],[27,0.39,0.95],[28,0.61,0.95]])landmarks[index]={x,y,visibility:1}
  return {id:'body-1',label:'人物 1',bounds:{x:0.2,y:0.15,width:0.6,height:0.8},landmarks,
    mask:{width:20,height:20,data:new Uint8ClampedArray(400).fill(255)},thumbnail:''}
}
function gradient(width:number,height:number):Uint8ClampedArray{
  const pixels=new Uint8ClampedArray(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set([x%256,y%256,(x+y)%256,255],(y*width+x)*4)
  return pixels
}
function render(source:Uint8ClampedArray,current:Uint8ClampedArray,subjects:PortraitWarpSubject[],width=200,height=160){
  const output=new Uint8ClampedArray(current)
  mergePortraitWarpStrip(source,output,createPortraitWarpPlan(subjects,width,height),0,0)
  return output
}

describe('fixed-source local portrait geometry',()=>{
  it('sanitizes unsafe settings and bounds signed controls separately',()=>{
    expect(normalizeShapeSettings({faceSlim:200,jawSlim:-100,chinLength:-150,shoulderWidth:Infinity,waistSlim:NaN})).toEqual({...DEFAULT_SHAPE_SETTINGS,faceSlim:100,chinLength:-100})
    expect(()=>createPortraitWarpPlan([],9000,9000)).toThrow(/4000/)
    expect(()=>createPortraitWarpPlan([{face:{...face(),landmarks:[]},settings:{}}],200,160)).toThrow(/关键点/)
  })
  it('moves contour pixels while fixing eye, eyebrow, nose and mouth landmarks',()=>{
    const person=face(),plan=createPortraitWarpPlan([{face:person,settings:{faceSlim:100,jawSlim:100,chinLength:100}}],1000,800)
    let moved=0
    for(const index of OVAL){const point=person.landmarks[index],offset=portraitWarpOffset(plan,point.x*1000,point.y*800);if(Math.hypot(offset.dx,offset.dy)>1)moved++}
    expect(moved).toBeGreaterThan(7)
    for(const group of FEATURES)for(const index of group){const point=person.landmarks[index];expect(portraitWarpOffset(plan,point.x*1000,point.y*800)).toMatchObject({dx:0,dy:0})}
  })
  it('rotates contour and chin movements with the face while retaining feature anchors',()=>{
    const person=face(),angle=Math.PI/6,cos=Math.cos(angle),sin=Math.sin(angle),width=1000,height=1000
    const rotated={...person,landmarks:person.landmarks.map(point=>({
      x:0.5+(point.x-0.5)*cos-(point.y-0.3)*sin,y:0.3+(point.x-0.5)*sin+(point.y-0.3)*cos,
    }))}
    const flat=createPortraitWarpPlan([{face:person,settings:{faceSlim:100,jawSlim:100,chinLength:100}}],width,height)
    const tilted=createPortraitWarpPlan([{face:rotated,settings:{faceSlim:100,jawSlim:100,chinLength:100}}],width,height)
    for(const index of [93,323,172,397,152]){
      const a=person.landmarks[index],b=rotated.landmarks[index]
      const original=portraitWarpOffset(flat,a.x*width,a.y*height),result=portraitWarpOffset(tilted,b.x*width,b.y*height)
      expect(result.dx).toBeCloseTo(original.dx*cos-original.dy*sin,6)
      expect(result.dy).toBeCloseTo(original.dx*sin+original.dy*cos,6)
    }
    for(const group of FEATURES)for(const index of group){const point=rotated.landmarks[index];expect(portraitWarpOffset(tilted,point.x*width,point.y*height)).toMatchObject({dx:0,dy:0})}
  })
  it('samples original pixels rather than accumulating earlier slider output',()=>{
    const source=gradient(200,160),original=new Uint8ClampedArray(source)
    const subjects=[{face:face(),settings:{faceSlim:100,chinLength:70}}]
    const first=render(source,source,subjects),again=render(source,first,subjects)
    expect(first).not.toEqual(source)
    expect(again).toEqual(first)
    expect(source).toEqual(original)
    const mild=render(source,first,[{face:face(),settings:{faceSlim:20},previousSettings:subjects[0].settings}])
    const direct=render(source,source,[{face:face(),settings:{faceSlim:20}}])
    expect(mild).toEqual(direct)
  })
  it('restores all previous affected pixels when shaping is returned to zero',()=>{
    const source=gradient(200,160),person=face(),settings={faceSlim:100,jawSlim:100,chinLength:-100}
    const changed=render(source,source,[{face:person,settings}])
    expect(changed).not.toEqual(source)
    expect(render(source,changed,[{face:person,settings:DEFAULT_SHAPE_SETTINGS,previousSettings:settings}])).toEqual(source)
  })
  it('copies fresh skin finishing with zero geometry while keeping unrelated current bytes',()=>{
    const source=gradient(200,160),current=new Uint8ClampedArray(source.length).fill(17)
    const plan=createPortraitWarpPlan([{face:face(),settings:{}}],200,160),output=new Uint8ClampedArray(current)
    mergePortraitWarpStrip(source,output,plan,0,0)
    const inside=(50*200+100)*4,outside=(140*200+10)*4
    expect(output.slice(inside,inside+4)).toEqual(source.slice(inside,inside+4))
    expect(output.slice(outside,outside+4)).toEqual(current.slice(outside,outside+4))
  })
  it('hard-protects all four current channels even at red alpha 1 and limits editing to green',()=>{
    const source=gradient(200,160),current=new Uint8ClampedArray(source.length).fill(123),output=new Uint8ClampedArray(current)
    const protection=new Uint8ClampedArray(32000),selection=new Uint8ClampedArray(32000)
    for(let y=30;y<75;y++)for(let x=75;x<125;x++)selection[y*200+x]=255
    for(const [i,value]of [[50*200+95,1],[50*200+100,128],[50*200+105,255]])protection[i]=value
    const plan=createPortraitWarpPlan([{face:face(),settings:{faceSlim:100}}],200,160)
    expect(mergePortraitWarpStrip(source,output,plan,0,0,protection,selection)).toBe(true)
    for(let pixel=0;pixel<32000;pixel++)if(protection[pixel]||!selection[pixel])expect(output.slice(pixel*4,pixel*4+4)).toEqual(current.slice(pixel*4,pixel*4+4))
  })
  it('preserves pixels under other people’s independent segmentation masks',()=>{
    const source=gradient(200,160),current=new Uint8ClampedArray(source.length).fill(177),output=new Uint8ClampedArray(current)
    const other=body();other.mask={width:200,height:160,data:new Uint8ClampedArray(32000)}
    for(let y=30;y<65;y++)for(let x=80;x<120;x++)other.mask.data[y*200+x]=255
    const plan=createPortraitWarpPlan([{face:face(),settings:{faceSlim:100}}],200,160,[other])
    mergePortraitWarpStrip(source,output,plan,0,0)
    for(let y=30;y<65;y++)for(let x=80;x<120;x++){const i=(y*200+x)*4;expect(output.slice(i,i+4)).toEqual(current.slice(i,i+4))}
  })
  it('feathers fractional green against a fixed image without accumulating repeated applications',()=>{
    const source=gradient(200,160),base=new Uint8ClampedArray(source),selection=new Uint8ClampedArray(32000).fill(128)
    const plan=createPortraitWarpPlan([{face:face(),settings:{faceSlim:100}}],200,160)
    for(let y=30;y<65;y++)for(let x=80;x<120;x++)source[(y*200+x)*4]+=25
    const first=new Uint8ClampedArray(base)
    mergePortraitWarpStrip(source,first,plan,0,0,null,selection,base)
    const again=new Uint8ClampedArray(first)
    mergePortraitWarpStrip(source,again,plan,0,0,null,selection,base)
    expect(again).toEqual(first)
    const i=(50*200+100)*4
    expect(first[i]).toBe(base[i]+13)
  })
  it('protects another person’s face even when their body was not detected',()=>{
    const source=gradient(200,160),output=new Uint8ClampedArray(source),other=face()
    const plan=createPortraitWarpPlan([{body:body(),settings:{shoulderWidth:100,armSlim:100}}],200,160,[],[other])
    mergePortraitWarpStrip(source,output,plan,0,0)
    let outsideChanges=0
    for(let y=0;y<160;y++)for(let x=0;x<200;x++){
      const i=(y*200+x)*4,diff=source[i]!==output[i]||source[i+1]!==output[i+1]||source[i+2]!==output[i+2]
      const centered=(x/200-0.5)**2/0.19**2+(y/160-0.3)**2/0.24**2<1
      if(centered)expect(output.slice(i,i+4)).toEqual(source.slice(i,i+4))
      else if(diff)outsideChanges++
    }
    expect(outsideChanges).toBeGreaterThan(100)
  })
  it('exposes bounded waist, arm, leg and bidirectional shoulder shaping without low-confidence controls',()=>{
    const person=body(),settings:ShapeSettings={...DEFAULT_SHAPE_SETTINGS,waistSlim:100,armSlim:100,legSlim:100,shoulderWidth:100}
    const plan=createPortraitWarpPlan([{body:person,settings}],1000,1000)
    expect(plan.fields).toHaveLength(11)
    for(let y=0;y<1000;y+=11)for(let x=0;x<1000;x+=11){const d=portraitWarpOffset(plan,x,y);expect(Number.isFinite(d.dx)&&Number.isFinite(d.dy)).toBe(true);expect(Math.hypot(d.dx,d.dy)).toBeLessThan(35)}
    for(const point of person.landmarks)point.visibility=0.1
    expect(createPortraitWarpPlan([{body:person,settings}],1000,1000).fields).toHaveLength(0)
    const wide=createPortraitWarpPlan([{body:body(),settings:{shoulderWidth:100}}],1000,1000)
    const narrow=createPortraitWarpPlan([{body:body(),settings:{shoulderWidth:-100}}],1000,1000)
    expect(portraitWarpOffset(wide,360,280).dx).toBeGreaterThan(0)
    expect(portraitWarpOffset(narrow,360,280).dx).toBeLessThan(0)
  })
  it('produces the same result from bounded source bands as from a full-image pass',()=>{
    const width=200,height=160,source=gradient(width,height),full=new Uint8ClampedArray(source),strip=new Uint8ClampedArray(source)
    const plan=createPortraitWarpPlan([{face:face(),body:body(),settings:{faceSlim:100,chinLength:100,armSlim:80,waistSlim:70}}],width,height)
    mergePortraitWarpStrip(source,full,plan,0,0)
    for(let y=0;y<height;y+=17){const rows=Math.min(17,height-y),sourceY=Math.max(0,y-plan.maxSourcePadding),sourceEnd=Math.min(height,y+rows+plan.maxSourcePadding)
      const band=source.slice(sourceY*width*4,sourceEnd*width*4),target=strip.slice(y*width*4,(y+rows)*width*4)
      mergePortraitWarpStrip(band,target,plan,y,sourceY);strip.set(target,y*width*4)
    }
    expect(strip).toEqual(full)
    expect(()=>mergePortraitWarpStrip(source,new Uint8ClampedArray(5),plan,0,0)).toThrow(/尺寸/)
  })
  it('adjusts half-body shoulders even when hip points are out of frame or low confidence',()=>{
    const person=body()
    person.landmarks[23]={x:.4,y:1.3,visibility:1}
    person.landmarks[24]={x:.6,y:.7,visibility:.1}
    const plan=createPortraitWarpPlan([{body:person,settings:{shoulderWidth:100,waistSlim:100}}],1000,1000)
    expect(plan.fields).toHaveLength(2)
    expect(portraitWarpOffset(plan,360,280).dx).toBeGreaterThan(10)
    expect(portraitWarpOffset(plan,640,280).dx).toBeLessThan(-10)
    const reversed=createPortraitWarpPlan([{body:person,settings:{shoulderWidth:-100}}],1000,1000)
    expect(portraitWarpOffset(reversed,360,280).dx).toBeLessThan(-10)
    expect(portraitWarpOffset(reversed,640,280).dx).toBeGreaterThan(10)
  })
})
