import type { PortraitSessionSnapshot } from '../portrait/PortraitPanel';
import type { AutomaticRetouchSession } from '../portrait/automatic-session';

/** A revision includes the processing baseline, not just the displayed pixels. */
export interface EditRevision {
  image: string;
  width: number;
  height: number;
  comparison: string;
  portrait: PortraitSessionSnapshot | null;
  automatic?: AutomaticRetouchSession;
}

export interface EditorDocument {
  id: string; name: string; original: string; current: string;
  width: number; height: number; comparison?: string;
  history: EditRevision[]; future: EditRevision[]; edits: number;
  exportedCurrent?: string;
  sourceInfo?: string;
  automatic?: AutomaticRetouchSession;
}

export function revisionOf(document: EditorDocument, portrait: PortraitSessionSnapshot | null): EditRevision {
  return { image: document.current, width: document.width, height: document.height,
    comparison: document.comparison || document.original, portrait, automatic: document.automatic };
}

export function restoreRevision<T extends EditorDocument>(document: T, revision: EditRevision): T {
  return { ...document, current: revision.image, width: revision.width, height: revision.height, comparison: revision.comparison, automatic: revision.automatic };
}
