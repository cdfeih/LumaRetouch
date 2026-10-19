import { createPortraitWarpPlan } from './warp'
import type { PortraitWarpSubject } from './warp'
import type { PortraitBody } from './body'
import type { PortraitFace } from './detection'
import type { WarpWorkerRequest, WarpWorkerResponse } from './warp.worker'

export type PortraitWarpOptions = {
  protection?: HTMLCanvasElement | null
  selection?: HTMLCanvasElement | null
  signal?: AbortSignal
  excludedBodies?: PortraitBody[]
  excludedFaces?: PortraitFace[]
  /** Fixed, pre-retouch session image for fractional green-brush feathering. */
  blendBaseline?: string
}
const cancelled=()=>new DOMException('已取消本次人像精修。','AbortError')
const check=(signal?:AbortSignal)=>{if(signal?.aborted)throw cancelled()}
function readImage(source:string,signal?:AbortSignal):Promise<HTMLImageElement>{
  check(signal)
  if(!/^data:image\/[a-z0-9.+-]+;base64,/i.test(source))throw new Error('人像照片数据无效，请重新导入。')
  return new Promise((resolve,reject)=>{
    const image=new Image();image.decoding='async'
    const cleanup=()=>{image.onload=image.onerror=null;signal?.removeEventListener('abort',abort)}
    const abort=()=>{cleanup();image.src='';reject(cancelled())}
    image.onload=()=>{
      cleanup()
      if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth*image.naturalHeight>40_000_000){image.src='';reject(new Error('照片尺寸无效或超过 4000 万像素，请缩小后重试。'))}
      else resolve(image)
    }
    image.onerror=()=>{cleanup();reject(new Error('照片解码失败，请重新导入。'))}
    signal?.addEventListener('abort',abort,{once:true});image.src=source
  })
}
function surface(width:number,height:number){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
  const context=canvas.getContext('2d',{willReadFrequently:true})
  if(!context)throw new Error('浏览器无法创建人像塑形画布。')
  return {canvas,context}
}
function maskPresent(canvas:HTMLCanvasElement|null|undefined):boolean{
  if(!canvas||!canvas.width||!canvas.height)return false
  const context=canvas.getContext('2d')
  if(!context)throw new Error('无法读取人像编辑或保护选区。')
  // Read bounded strips, even if a user imported an unusually large mask.
  for(let y=0;y<canvas.height;y+=128){
    const data=context.getImageData(0,y,canvas.width,Math.min(128,canvas.height-y)).data
    for(let i=3;i<data.length;i+=4)if(data[i])return true
  }
  return false
}
function alpha(data:Uint8ClampedArray):Uint8ClampedArray{
  const result=new Uint8ClampedArray(data.length/4)
  for(let i=0;i<result.length;i++)result[i]=data[i*4+3]
  return result
}
function requestStrip(worker:Worker,request:Extract<WarpWorkerRequest,{type:'strip'}>,signal?:AbortSignal):Promise<{data:Uint8ClampedArray;changed:boolean}>{
  check(signal)
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{signal?.removeEventListener('abort',abort);worker.onmessage=worker.onerror=null}
    const abort=()=>{cleanup();worker.terminate();reject(cancelled())}
    signal?.addEventListener('abort',abort,{once:true})
    worker.onerror=()=>{cleanup();reject(new Error('本地人像塑形线程加载或运行失败，请刷新重试。'))}
    worker.onmessage=(event:MessageEvent<WarpWorkerResponse>)=>{
      cleanup()
      if(signal?.aborted){reject(cancelled());return}
      if(!event.data.ok){reject(new Error(event.data.error));return}
      resolve({data:new Uint8ClampedArray(event.data.current),changed:event.data.changed})
    }
    try{
      const transfer=[request.source,request.current]
      if(request.protection)transfer.push(request.protection)
      if(request.selection)transfer.push(request.selection)
      if(request.blendBaseline)transfer.push(request.blendBaseline)
      worker.postMessage(request,transfer)
    }catch{cleanup();reject(new Error('照片无法传入本地塑形线程，请重试。'))}
  })
}
function encode(canvas:HTMLCanvasElement,signal?:AbortSignal):Promise<string>{
  check(signal)
  return new Promise((resolve,reject)=>{
    let reader:FileReader|null=null
    const cleanup=()=>signal?.removeEventListener('abort',abort)
    const abort=()=>{cleanup();reader?.abort();reject(cancelled())}
    signal?.addEventListener('abort',abort,{once:true})
    try{canvas.toBlob(blob=>{
      if(signal?.aborted)return
      if(!blob){cleanup();reject(new Error('人像精修结果编码失败，设备可能内存不足。'));return}
      reader=new FileReader();reader.onload=()=>{cleanup();resolve(reader!.result as string)}
      reader.onerror=()=>{cleanup();reject(new Error('读取人像精修结果失败。'))};reader.readAsDataURL(blob)
    },'image/png')}catch{cleanup();reject(new Error('人像精修结果编码失败，请尝试较小照片。'))}
  })
}

/** A fresh, fixed candidate (skin finishing may already be included) is sampled
 * into current only within this person's face/current-or-previous shape ROI.
 * Caller keeps the same session baseline and supplies previousSettings so
 * lowering a slider all the way to zero restores its former deformation. */
export async function renderPortraitWarp(baseline:string,current:string,subjects:PortraitWarpSubject[],options:PortraitWarpOptions={}):Promise<string>{
  check(options.signal)
  if(!subjects.length)return current
  const surfaces:HTMLCanvasElement[]=[]
  const make=(w:number,h:number)=>{const value=surface(w,h);surfaces.push(value.canvas);return value}
  let sourceImage:HTMLImageElement|undefined,currentImage:HTMLImageElement|undefined,blendImage:HTMLImageElement|undefined,worker:Worker|undefined
  try{
    sourceImage=await readImage(baseline,options.signal)
    currentImage=baseline===current?sourceImage:await readImage(current,options.signal)
    const width=sourceImage.naturalWidth,height=sourceImage.naturalHeight
    if(currentImage.naturalWidth!==width||currentImage.naturalHeight!==height)throw new Error('当前照片与人像精修基准尺寸不一致，请重新识别。')
    const plan=createPortraitWarpPlan(subjects,width,height,options.excludedBodies,options.excludedFaces)
    const snapshot=(mask:HTMLCanvasElement|null|undefined)=>{
      if(!maskPresent(mask))return null
      const copy=make(mask!.width,mask!.height);copy.context.drawImage(mask!,0,0);return copy.canvas
    }
    const protection=snapshot(options.protection),selection=snapshot(options.selection)
    if(selection&&options.blendBaseline&&options.blendBaseline!==baseline){
      blendImage=options.blendBaseline===current?currentImage:await readImage(options.blendBaseline,options.signal)
      if(blendImage.naturalWidth!==width||blendImage.naturalHeight!==height)throw new Error('人像精修羽化基准尺寸不一致，请重新识别。')
    }
    check(options.signal)
    if(!plan.fields.length&&!plan.restoreFields.length&&!plan.faces.length)return current
    try{worker=new Worker(new URL('./warp.worker.ts',import.meta.url),{type:'module'})}
    catch{throw new Error('无法启动本地塑形线程，请更新浏览器或使用安装版。')}
    worker.postMessage({type:'init',plan} satisfies WarpWorkerRequest)
    const target=make(width,height);target.context.drawImage(currentImage,0,0)
    const rows=Math.min(96,height),sourceStrip=make(width,Math.min(height,rows+plan.maxSourcePadding*2))
    const blendStrip=blendImage?make(width,rows):null
    const protectionStrip=protection?make(width,rows):null,selectionStrip=selection?make(width,rows):null
    if(protectionStrip)protectionStrip.context.imageSmoothingEnabled=false
    if(selectionStrip)selectionStrip.context.imageSmoothingEnabled=false
    let changed=false
    for(let y=0;y<height;y+=rows){
      check(options.signal)
      // Skip tile rows that cannot touch a selected face or shape field.
      let affected=false
      for(let tileY=Math.floor(y/64);tileY<=Math.floor(Math.min(height-1,y+rows-1)/64);tileY++){
        for(let tileX=0;tileX<plan.tileColumns;tileX++)if(plan.tiles[tileY*plan.tileColumns+tileX].length){affected=true;break}
        if(affected)break
      }
      if(!affected)continue
      const stripRows=Math.min(rows,height-y),sourceY=Math.max(0,y-plan.maxSourcePadding)
      const sourceRows=Math.min(height,y+stripRows+plan.maxSourcePadding)-sourceY
      sourceStrip.context.clearRect(0,0,width,sourceStrip.canvas.height)
      sourceStrip.context.drawImage(sourceImage,0,sourceY,width,sourceRows,0,0,width,sourceRows)
      const source=sourceStrip.context.getImageData(0,0,width,sourceRows).data
      const pixels=target.context.getImageData(0,y,width,stripRows).data
      let blendData:ArrayBuffer|undefined
      if(blendImage&&blendStrip){
        blendStrip.context.clearRect(0,0,width,rows);blendStrip.context.drawImage(blendImage,0,y,width,stripRows,0,0,width,stripRows)
        blendData=blendStrip.context.getImageData(0,0,width,stripRows).data.buffer as ArrayBuffer
      }
      const maskAlpha=(mask:HTMLCanvasElement|null,strip:ReturnType<typeof surface>|null)=>{
        if(!mask||!strip)return undefined
        strip.context.clearRect(0,0,width,rows);strip.context.drawImage(mask,0,-y,width,height)
        return alpha(strip.context.getImageData(0,0,width,stripRows).data).buffer as ArrayBuffer
      }
      const result=await requestStrip(worker,{type:'strip',source:source.buffer as ArrayBuffer,current:pixels.buffer as ArrayBuffer,startY:y,sourceY,
        protection:maskAlpha(protection,protectionStrip),selection:maskAlpha(selection,selectionStrip),blendBaseline:blendData},options.signal)
      if(result.data.length!==width*stripRows*4)throw new Error('人像塑形线程返回的条带尺寸不一致。')
      if(result.changed){target.context.putImageData(new ImageData(new Uint8ClampedArray(result.data),width,stripRows),0,y);changed=true}
    }
    check(options.signal)
    return changed?await encode(target.canvas,options.signal):current
  }finally{
    worker?.terminate()
    if(sourceImage)sourceImage.src=''
    if(currentImage&&currentImage!==sourceImage)currentImage.src=''
    if(blendImage&&blendImage!==sourceImage&&blendImage!==currentImage)blendImage.src=''
    for(const canvas of surfaces)canvas.width=canvas.height=1
  }
}
