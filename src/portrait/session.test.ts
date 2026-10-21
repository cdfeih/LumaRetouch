import { describe, expect, it } from 'vitest';
import { clonePortraitSession } from './session';
import { ZERO_PORTRAIT_SETTINGS } from './settings';
import type { PortraitSessionSnapshot } from './PortraitPanel';
describe('portrait edit-revision snapshots', () => {
  it('isolates mutable parameters, landmarks and body masks while keeping image strings shared', () => {
    const bounds = { x: .1, y: .1, width: .2, height: .3 };
    const face = { id: 'face-1', label: '人物 1', bounds, thumbnail: 'data:image/thumb', landmarks: [{ x: .2, y: .2 }] };
    const body = { id: 'body-1', label: '人物 1', bounds, thumbnail: '', landmarks: [{ x: .2, y: .3, visibility: .9 }], mask: { width: 1, height: 1, data: new Uint8ClampedArray([255]) } };
    const source: PortraitSessionSnapshot = { section: 'natural', people: [{ id: face.id, label: face.label, bounds, thumbnail: face.thumbnail, face, body }], scanned: true, bodyScanned: true, selected: face.id, parameters: { [face.id]: { ...ZERO_PORTRAIT_SETTINGS, brightening: 35 } }, common: { ...ZERO_PORTRAIT_SETTINGS }, detectedFaces: [face], detectedBodies: [body], deformationHistory: {}, baseline: 'data:image/original', knownSources: ['data:image/original', 'data:image/result'] };
    const copy = clonePortraitSession(source);
    expect(copy.baseline).toBe(source.baseline); expect(copy.knownSources).not.toBe(source.knownSources);
    expect(copy.people[0].face).toBe(copy.detectedFaces![0]); expect(copy.people[0].body).toBe(copy.detectedBodies![0]);
    copy.parameters[face.id].brightening = 100; copy.common.smoothing = 55;
    copy.detectedFaces![0].landmarks[0].x = 0; copy.detectedBodies![0].mask.data[0] = 0;
    copy.knownSources.push('data:image/later');
    expect(source.parameters[face.id].brightening).toBe(35); expect(source.common.smoothing).toBe(0);
    expect(face.landmarks[0].x).toBe(.2); expect(body.mask.data[0]).toBe(255); expect(source.knownSources).toHaveLength(2);
  });
});
