import type { PortraitFace, PortraitPoint } from './detection'
import type { PortraitBody } from './body'

export type ShapeSettings = {
  faceSlim: number
  jawSlim: number
  chinLength: number
  waistSlim: number
  armSlim: number
  legSlim: number
  shoulderWidth: number
}
export const DEFAULT_SHAPE_SETTINGS: ShapeSettings = {
  faceSlim: 0, jawSlim: 0, chinLength: 0, waistSlim: 0, armSlim: 0, legSlim: 0, shoulderWidth: 0,
}
export type PortraitWarpSubject = {
  face?: PortraitFace
  body?: PortraitBody
  settings: Partial<ShapeSettings>
  previousSettings?: Partial<ShapeSettings>
}
type Ellipse = { x: number; y: number; nx: number; ny: number; rx: number; ry: number }
type Field = Ellipse & { dx: number; dy: number; squeeze: number }
type FaceRegion = { points: PortraitPoint[]; left: number; right: number; top: number; bottom: number }
export type PortraitWarpPlan = {
  width: number; height: number; fields: Field[]; restoreFields: Field[]; anchors: Ellipse[]
  faces: FaceRegion[]; tiles: number[][]; tileColumns: number; maxSourcePadding: number
  excludedBodies: PortraitBody[]; excludedFaces: FaceRegion[]
}
const TILE = 64
const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
const FEATURES = [
  [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],
  [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466],
  [70,63,105,66,107,55,65,52,53,46], [300,293,334,296,336,285,295,282,283,276],
  [61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185],
  [1,2,4,5,6,19,94,97,98,168,195,197,326,327],
]
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

export function normalizeShapeSettings(input: Partial<ShapeSettings>): ShapeSettings {
  return Object.fromEntries(Object.keys(DEFAULT_SHAPE_SETTINGS).map(key => {
    const name = key as keyof ShapeSettings, value = input[name]
    return [name, clamp(typeof value === 'number' && Number.isFinite(value) ? value : 0,
      name === 'chinLength' || name === 'shoulderWidth' ? -100 : 0, 100)]
  })) as ShapeSettings
}

function ellipseWeight(field: Ellipse, x: number, y: number): number {
  const px = x - field.x, py = y - field.y
  const across = (px * field.nx + py * field.ny) / field.rx
  const along = (-px * field.ny + py * field.nx) / field.ry
  const radius = across * across + along * along
  return radius < 1 ? (1 - radius) * (1 - radius) : 0
}
function bounds(field: Ellipse) {
  const ex = Math.hypot(field.nx * field.rx, field.ny * field.ry)
  const ey = Math.hypot(field.ny * field.rx, field.nx * field.ry)
  return { left: field.x - ex, right: field.x + ex, top: field.y - ey, bottom: field.y + ey }
}
function validFace(face: PortraitFace): boolean {
  return face.landmarks.length >= 468 && face.landmarks.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
}
function faceGeometry(face: PortraitFace, width: number, height: number) {
  if (!validFace(face)) throw new Error('面部塑形关键点不完整，请重新识别人像。')
  const points = face.landmarks.map(point => ({ x: point.x * width, y: point.y * height }))
  const oval = OVAL.map(index => points[index])
  const left = Math.min(...oval.map(point => point.x)), right = Math.max(...oval.map(point => point.x))
  const top = Math.min(...oval.map(point => point.y)), bottom = Math.max(...oval.map(point => point.y))
  // Roll follows the eye line, so slimming and chin length stay relative to the
  // face rather than the photo's horizontal/vertical axes on a tilted portrait.
  let acrossX=points[263].x-points[33].x,acrossY=points[263].y-points[33].y
  if(Math.hypot(acrossX,acrossY)<1){acrossX=points[454].x-points[234].x;acrossY=points[454].y-points[234].y}
  const length=Math.hypot(acrossX,acrossY),nx=length?acrossX/length:1,ny=length?acrossY/length:0
  const across=oval.map(point=>point.x*nx+point.y*ny),along=oval.map(point=>-point.x*ny+point.y*nx)
  return { points, region: { points: oval, left, right, top, bottom }, nx,ny,
    fw:Math.max(...across)-Math.min(...across),fh:Math.max(...along)-Math.min(...along) }
}
function faceFields(face: PortraitFace, settings: ShapeSettings, width: number, height: number): Field[] {
  const { points, fw, fh,nx,ny } = faceGeometry(face, width, height)
  if (fw < 2 || fh < 2) return []
  const result: Field[] = []
  const centerX = (points[234].x + points[454].x) / 2,centerY=(points[234].y+points[454].y)/2
  const push = (index: number, amount: number, ry: number, dx: number, dy = 0) => {
    if (!amount) return
    result.push({ ...points[index], nx, ny, rx: fw * 0.32, ry,
      dx: dx * amount / 100, dy: dy * amount / 100, squeeze: 0 })
  }
  for (const [indices,amount,radius]of [[[93,323],settings.faceSlim,0.3],[[172,397],settings.jawSlim,0.23]] as const){
    for(const index of indices){
      const sign=Math.sign((points[index].x-centerX)*nx+(points[index].y-centerY)*ny)
      push(index,amount,fh*radius,sign*fw*0.045*nx,sign*fw*0.045*ny)
    }
  }
  push(152, settings.chinLength, fh * 0.2, ny*fh*0.065, -nx*fh*0.065)
  return result
}
function bodyPoint(body: PortraitBody, index: number, width: number, height: number): PortraitPoint | null {
  const point = body.landmarks[index]
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
    || (point.visibility ?? 1) < 0.5) return null
  return { x: point.x * width, y: point.y * height }
}
function maskValue(body: PortraitBody, x: number, y: number, width: number, height: number): number {
  const mask = body.mask
  if (!mask || mask.width < 1 || mask.height < 1 || mask.data.length !== mask.width * mask.height) return 0
  const mx = Math.floor(x * mask.width / width), my = Math.floor(y * mask.height / height)
  return mx < 0 || mx >= mask.width || my < 0 || my >= mask.height ? 0 : mask.data[my * mask.width + mx]
}
function bodyFields(body: PortraitBody, settings: ShapeSettings, width: number, height: number): Field[] {
  const result: Field[] = []
  const p = (index: number) => bodyPoint(body, index, width, height)
  const segment = (start: number, end: number, amount: number, radiusRatio: number) => {
    const a = p(start), b = p(end)
    if (!a || !b || !amount) return
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < 4) return
    const nx = (b.y - a.y) / length, ny = -(b.x - a.x) / length
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2
    const limit = length * radiusRatio
    let measured = limit
    // Segmentation narrows the support near isolated limbs. If a limb touches
    // the torso, anatomical limits prevent the mask's merged width inflating it.
    if (maskValue(body, x, y, width, height) >= 128) {
      const step = Math.max(1, limit / 30)
      let left = 0, right = 0
      for (let d = step; d <= limit; d += step) { if (maskValue(body, x - nx * d, y - ny * d, width, height) < 128) break; left = d }
      for (let d = step; d <= limit; d += step) { if (maskValue(body, x + nx * d, y + ny * d, width, height) < 128) break; right = d }
      measured = clamp((left + right) / 2, limit * 0.35, limit)
    }
    result.push({ x, y, nx, ny, rx: measured * 2.4, ry: length * 0.72,
      dx: 0, dy: 0, squeeze: amount / 100 * 0.2 })
  }
  for (const [a,b] of [[11,13],[13,15],[12,14],[14,16]]) segment(a,b,settings.armSlim,0.24)
  for (const [a,b] of [[23,25],[25,27],[24,26],[26,28]]) segment(a,b,settings.legSlim,0.21)
  const ls = p(11), rs = p(12), lh = p(23), rh = p(24)
  // Half-body photos often have reliable shoulders but hips outside the frame.
  // Shoulder width must not silently depend on a complete torso detection.
  if(ls&&rs&&settings.shoulderWidth){
    const span=Math.hypot(rs.x-ls.x,rs.y-ls.y),sx=(ls.x+rs.x)/2,sy=(ls.y+rs.y)/2
    const torso=lh&&rh?Math.hypot((lh.x+rh.x)/2-sx,(lh.y+rh.y)/2-sy):0
    const radiusY=torso>4?clamp(torso*0.32,span*0.22,span*0.65):span*0.38
    if(span>4)for(const point of [ls,rs])result.push({...point,
      nx:(rs.x-ls.x)/span,ny:(rs.y-ls.y)/span,rx:span*0.32,ry:radiusY,
      dx:-(point.x-sx)*settings.shoulderWidth/100*0.12,
      dy:-(point.y-sy)*settings.shoulderWidth/100*0.12,squeeze:0})
  }
  if (ls && rs && lh && rh) {
    const sx = (ls.x + rs.x) / 2, sy = (ls.y + rs.y) / 2
    const hx = (lh.x + rh.x) / 2, hy = (lh.y + rh.y) / 2
    const torso = Math.hypot(hx - sx, hy - sy), hips = Math.hypot(rh.x - lh.x, rh.y - lh.y)
    if (torso > 4 && hips > 4 && settings.waistSlim) result.push({ x: sx + (hx - sx) * 0.68, y: sy + (hy - sy) * 0.68,
      nx: (hy - sy) / torso, ny: -(hx - sx) / torso, rx: hips * 0.95, ry: torso * 0.52,
      dx: 0, dy: 0, squeeze: settings.waistSlim / 100 * 0.23 })
  }
  return result
}

/** Compile small local fields once; a 64px spatial index avoids testing every
 * person's controls at every full-resolution pixel. Coordinates map output
 * back to the fixed source, so no generated face detail or cumulative resampling. */
export function createPortraitWarpPlan(subjects: PortraitWarpSubject[], width: number, height: number, excludedBodies: PortraitBody[] = [], excludedFaces: PortraitFace[] = []): PortraitWarpPlan {
  if (![width,height].every(value => Number.isSafeInteger(value) && value > 0) || width * height > 40_000_000) throw new Error('人像塑形尺寸无效或超过 4000 万像素。')
  const fields: Field[] = [], restoreFields: Field[] = [], anchors: Ellipse[] = [], faces: FaceRegion[] = []
  for (const subject of subjects) {
    const settings = normalizeShapeSettings(subject.settings), previous = normalizeShapeSettings(subject.previousSettings ?? {})
    if (subject.face) {
      const geometry = faceGeometry(subject.face,width,height)
      faces.push(geometry.region)
      for (const indices of FEATURES) {
        const points = indices.map(index => geometry.points[index])
        const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x))
        const top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y))
        anchors.push({ x: (left + right) / 2, y: (top + bottom) / 2, nx: 1, ny: 0,
          rx: Math.max(2,(right-left) * 0.78), ry: Math.max(2,(bottom-top) * 0.85) })
      }
      fields.push(...faceFields(subject.face,settings,width,height))
      restoreFields.push(...faceFields(subject.face,previous,width,height))
    }
    if (subject.body) {
      fields.push(...bodyFields(subject.body,settings,width,height))
      restoreFields.push(...bodyFields(subject.body,previous,width,height))
    }
  }
  const tileColumns = Math.ceil(width / TILE), tiles: number[][] = Array.from({ length: tileColumns * Math.ceil(height / TILE) }, () => [])
  const regions = [...fields,...restoreFields,...faces]
  regions.forEach((region,index) => {
    const box = index < fields.length + restoreFields.length ? bounds(region as Field) : region as FaceRegion
    const x0 = clamp(Math.floor(box.left/TILE),0,tileColumns-1), x1 = clamp(Math.floor(box.right/TILE),0,tileColumns-1)
    const y0 = clamp(Math.floor(box.top/TILE),0,Math.ceil(height/TILE)-1), y1 = clamp(Math.floor(box.bottom/TILE),0,Math.ceil(height/TILE)-1)
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) tiles[y*tileColumns+x].push(index)
  })
  const maxSourcePadding = Math.ceil(Math.max(0,...fields.map(field => Math.abs(field.dy) + Math.abs(field.ny) * field.rx * Math.abs(field.squeeze)))) + 2
  return { width,height,fields,restoreFields,anchors,faces,tiles,tileColumns,maxSourcePadding,excludedBodies,
    excludedFaces:excludedFaces.map(face=>faceGeometry(face,width,height).region) }
}
function inPolygon(region: FaceRegion, x: number, y: number): boolean {
  if (x < region.left || x > region.right || y < region.top || y > region.bottom) return false
  let inside = false
  for (let i=0,j=region.points.length-1;i<region.points.length;j=i++) {
    const a=region.points[i],b=region.points[j]
    if ((a.y>y)!==(b.y>y) && x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x) inside=!inside
  }
  return inside
}

export function portraitWarpOffset(plan: PortraitWarpPlan, x: number, y: number, result = { dx: 0, dy: 0, editable: false }): { dx: number; dy: number; editable: boolean } {
  const indices=plan.tiles[Math.floor(y/TILE)*plan.tileColumns+Math.floor(x/TILE)] ?? []
  let dx=0,dy=0,total=0,editable=false
  for (const index of indices) {
    if (index >= plan.fields.length+plan.restoreFields.length) {
      if (inPolygon(plan.faces[index-plan.fields.length-plan.restoreFields.length],x,y)) editable=true
      continue
    }
    const active=index<plan.fields.length
    const field=active?plan.fields[index]:plan.restoreFields[index-plan.fields.length]
    const weight=ellipseWeight(field,x,y)
    if (weight<=0) continue
    editable=true
    if (!active) continue
    const distance=(x-field.x)*field.nx+(y-field.y)*field.ny
    dx+=(field.dx+field.nx*distance*field.squeeze)*weight
    dy+=(field.dy+field.ny*distance*field.squeeze)*weight
    total+=weight
  }
  if (total>1) { dx/=total;dy/=total }
  if (dx||dy) for (const anchor of plan.anchors) if (ellipseWeight(anchor,x,y)>0) { dx=0;dy=0;break }
  result.dx=dx;result.dy=dy;result.editable=editable
  return result
}

/** Mutates only the output strip. Hard red protection and other people's masks
 * beat green selection. ROI-exterior bytes are never read from the baseline. */
export function mergePortraitWarpStrip(
  source: Uint8ClampedArray, current: Uint8ClampedArray, plan: PortraitWarpPlan,
  startY: number, sourceY: number, protection?: Uint8ClampedArray | null, selection?: Uint8ClampedArray | null,
  blendBaseline?: Uint8ClampedArray | null,
): boolean {
  const {width,height}=plan, rows=current.length/4/width, sourceRows=source.length/4/width
  if (!Number.isInteger(rows)||!Number.isInteger(sourceRows)||rows<1||sourceRows<1||!Number.isInteger(startY)||!Number.isInteger(sourceY)
    ||startY<0||startY+rows>height||sourceY<0||sourceY+sourceRows>height||sourceY>startY||sourceY+sourceRows<startY+rows
    ||(protection&&protection.length!==width*rows)||(selection&&selection.length!==width*rows)
    ||(blendBaseline&&blendBaseline.length!==current.length)) throw new Error('人像塑形条带尺寸不一致。')
  let changed=false
  const field={dx:0,dy:0,editable:false}
  for (let row=0;row<rows;row++) for (let x=0;x<width;x++) {
    const pixel=row*width+x,offset=pixel*4,y=startY+row
    if ((protection&&protection[pixel]>0)||(selection&&selection[pixel]===0)) continue
    let excluded=false
    for (const body of plan.excludedBodies) if (maskValue(body,x,y,width,height)>=128) {excluded=true;break}
    if(!excluded)for(const face of plan.excludedFaces)if(inPolygon(face,x,y)){excluded=true;break}
    if (excluded) continue
    portraitWarpOffset(plan,x,y,field)
    if (!field.editable) continue
    const sx=clamp(x+field.dx,0,width-1),sy=clamp(y+field.dy,0,height-1)
    const x0=Math.floor(sx),x1=Math.min(width-1,x0+1),y0=Math.floor(sy),y1=Math.min(height-1,y0+1)
    if (y0<sourceY||y1>=sourceY+sourceRows) throw new Error('人像塑形源条带范围不足。')
    const fx=sx-x0,fy=sy-y0,a=((y0-sourceY)*width+x0)*4,b=((y0-sourceY)*width+x1)*4
    const c=((y1-sourceY)*width+x0)*4,d=((y1-sourceY)*width+x1)*4,amount=selection?selection[pixel]/255:1
    for (let channel=0;channel<4;channel++) {
      const target=(source[a+channel]*(1-fx)+source[b+channel]*fx)*(1-fy)+(source[c+channel]*(1-fx)+source[d+channel]*fx)*fy
      // Feather against an immutable baseline, never against the last preview.
      // Otherwise alpha-128 brush edges strengthen on each slider application.
      const fixed=blendBaseline?blendBaseline[offset+channel]:source[((y-sourceY)*width+x)*4+channel]
      const value=Math.round(fixed+(target-fixed)*amount)
      if (value!==current[offset+channel]) changed=true
      current[offset+channel]=value
    }
  }
  return changed
}
