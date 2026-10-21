import type { PortraitSessionSnapshot } from './PortraitPanel';
import type { PortraitFace } from './detection';
import type { PortraitBody } from './body';

/** Image/thumbnail strings are immutable and can be shared between revisions.
 * Copy only mutable data, preserving face/body aliases within one snapshot. */
export function clonePortraitSession(source: PortraitSessionSnapshot): PortraitSessionSnapshot {
  const faces = new Map<PortraitFace, PortraitFace>(), bodies = new Map<PortraitBody, PortraitBody>();
  const face = (value: PortraitFace): PortraitFace => {
    let copied = faces.get(value);
    if (!copied) { copied = { ...value, bounds: { ...value.bounds }, landmarks: value.landmarks.map(point => ({ ...point })) }; faces.set(value, copied); }
    return copied;
  };
  const body = (value: PortraitBody): PortraitBody => {
    let copied = bodies.get(value);
    if (!copied) { copied = { ...value, bounds: { ...value.bounds }, landmarks: value.landmarks.map(point => ({ ...point })), mask: { ...value.mask, data: new Uint8ClampedArray(value.mask.data) } }; bodies.set(value, copied); }
    return copied;
  };
  return {
    ...source,
    people: source.people.map(person => ({ ...person, bounds: { ...person.bounds }, face: person.face ? face(person.face) : undefined, body: person.body ? body(person.body) : undefined })),
    parameters: Object.fromEntries(Object.entries(source.parameters).map(([key, value]) => [key, { ...value }])),
    common: { ...source.common },
    detectedFaces: source.detectedFaces?.map(face) ?? null,
    detectedBodies: source.detectedBodies?.map(body) ?? null,
    deformationHistory: Object.fromEntries(Object.entries(source.deformationHistory).map(([key, value]) => [key, { ...value }])),
    knownSources: [...source.knownSources],
  };
}
