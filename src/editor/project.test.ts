import { describe, expect, it } from 'vitest';
import { packProjectDraft, unpackProjectDraft } from './project';
import type { ProjectDraft } from './project';

describe('local project draft', () => {
  const image = 'data:image/png;base64,YWJj';
  it('shares image blobs across original, history and processing baselines', () => {
    const project = { version: 1, activeId: 'a', documents: [{ id: 'a', original: image, current: image,
      history: [{ image, portrait: { baseline: image, knownSources: [image] } }] }], sessions: {}, masks: {}, savedAt: 1 } as unknown as ProjectDraft;
    const packed = packProjectDraft(project);
    expect(packed.assets).toHaveLength(1);
    expect(packed.assets[0].type).toBe('image/png');
    expect(packed.assets[0].size).toBe(3);
    expect(JSON.stringify(packed.tree)).not.toContain('base64');
  });
  it('rejects unsupported versions and missing image assets before restoring a session', async () => {
    await expect(unpackProjectDraft({ version: 99 } as never)).rejects.toThrow('格式不兼容');
    await expect(unpackProjectDraft({ version: 1, assets: [], tree: { imageAsset: 7 } })).rejects.toThrow('缺少图片');
  });
  it('round-trips body mask typed arrays and shared references through structured clone', async () => {
    const mask = new Uint8ClampedArray([0, 1, 128, 255]);
    const body = { mask: { width: 2, height: 2, data: mask } };
    const project = { version: 1, activeId: '', documents: [], sessions: { body: { mask, detectedMask: mask, people: [{ body }], detectedBodies: [body] } }, masks: {}, savedAt: 1 } as unknown as ProjectDraft;
    const packed = packProjectDraft(project);
    const restored = await unpackProjectDraft(structuredClone(packed));
    const session = restored.sessions.body as unknown as { mask: Uint8ClampedArray; detectedMask: Uint8ClampedArray };
    expect(session.mask).toBeInstanceOf(Uint8ClampedArray);
    expect([...session.mask]).toEqual([0, 1, 128, 255]);
    expect(session.mask).toBe(session.detectedMask);
    expect(session.mask).not.toBe(mask);
    expect(restored.sessions.body.people[0].body).toBe(restored.sessions.body.detectedBodies![0]);
    session.mask[0] = 99;
    expect(mask[0]).toBe(0);
  });
});
