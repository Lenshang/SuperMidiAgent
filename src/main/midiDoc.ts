/** MidiDocument 的解析辅助（带缓存的便利层）。 */
import { MidiDocument } from '../shared/midi/types';
import { parseMidi } from '../shared/midi/parser';

export type { MidiDocument };

export function parseDocumentSafely(bytes: Uint8Array): MidiDocument | undefined {
  try {
    return parseMidi(bytes);
  } catch {
    return undefined;
  }
}
