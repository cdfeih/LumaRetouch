import { mergePortraitWarpStrip } from './warp'
import type { PortraitWarpPlan } from './warp'

export type WarpWorkerRequest = { type: 'init'; plan: PortraitWarpPlan } | {
  type: 'strip'; source: ArrayBuffer; current: ArrayBuffer; startY: number; sourceY: number
  protection?: ArrayBuffer; selection?: ArrayBuffer; blendBaseline?: ArrayBuffer
}
export type WarpWorkerResponse = { ok: true; current: ArrayBuffer; changed: boolean } | { ok: false; error: string }

const scope=self as unknown as {
  onmessage: ((event: MessageEvent<WarpWorkerRequest>)=>void)|null
  postMessage: (message: WarpWorkerResponse, transfer?:Transferable[])=>void
}
let plan:PortraitWarpPlan|undefined
scope.onmessage=event=>{
  try {
    const request=event.data
    if (request.type==='init') {plan=request.plan;return}
    if (!plan) throw new Error('人像塑形线程尚未初始化。')
    const current=new Uint8ClampedArray(request.current)
    const changed=mergePortraitWarpStrip(new Uint8ClampedArray(request.source),current,plan,request.startY,request.sourceY,
      request.protection?new Uint8ClampedArray(request.protection):null,request.selection?new Uint8ClampedArray(request.selection):null,
      request.blendBaseline?new Uint8ClampedArray(request.blendBaseline):null)
    scope.postMessage({ok:true,current:current.buffer,changed},[current.buffer])
  } catch(error) {scope.postMessage({ok:false,error:error instanceof Error?error.message:'本地人像塑形失败。'})}
}
