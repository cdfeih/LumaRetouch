import type { AutomaticRetouchProfile } from './auto-retouch';
import type { PortraitSettings } from './settings';

/** Accepted result metadata, saved with its revision for repeat/undo/reload safety. */
export interface AutomaticRetouchSession {
  baseline: string;
  /** A different scope starts from the currently displayed result. */
  maskSignature: string;
  knownSources: string[];
  profile: AutomaticRetouchProfile;
  exposure: number;
  summary: string;
  warnings: string[];
  faces: Array<{ label: string; settings: PortraitSettings }>;
}
