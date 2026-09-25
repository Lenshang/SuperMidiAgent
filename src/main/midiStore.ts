/** MIDI 资产存储：内存 + 磁盘持久化（userData/midi/<id>.mid + index.json）。 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { MidiAssetMeta } from '../shared/types';
import { MidiDocument, parseDocumentSafely } from './midiDoc';
import { writeMidi } from '../shared/midi/writer';
import { parseMidi } from '../shared/midi/parser';
import { analyzeStats } from '../shared/midi/analysis';

interface StoredAsset {
  meta: MidiAssetMeta;
  bytes: Uint8Array;
}

export class MidiStore {
  private assets = new Map<string, StoredAsset>();

  constructor(private dir: string | null) {}

  async init(): Promise<void> {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(path.join(this.dir, 'index.json'), 'utf8');
      const index: { id: string; meta: MidiAssetMeta }[] = JSON.parse(raw);
      for (const entry of index) {
        try {
          const bytes = new Uint8Array(await fs.readFile(path.join(this.dir, `${entry.id}.mid`)));
          this.assets.set(entry.id, { meta: entry.meta, bytes });
        } catch {
          // 单个文件缺失，跳过
        }
      }
    } catch {
      // 索引不存在，空库
    }
  }

  async create(
    doc: MidiDocument,
    title: string,
    source: MidiAssetMeta['source'],
    opts: { sessionId?: string; parentIds?: string[] } = {},
  ): Promise<MidiAssetMeta> {
    const bytes = writeMidi(doc);
    const stats = analyzeStats(doc);
    const id = randomUUID().slice(0, 8);
    const meta: MidiAssetMeta = {
      id,
      title: title || `MIDI-${id}`,
      tempoBpm: stats.tempoBpm,
      barCount: stats.barCount,
      noteCount: stats.totalNotes,
      trackCount: doc.tracks.length,
      durationSec: Math.round(stats.durationSec * 10) / 10,
      tracks: stats.tracks.map((t) => ({
        index: t.index,
        name: t.name,
        program: t.program,
        noteCount: t.noteCount,
        ccCounts: Object.fromEntries(Object.entries(t.controllers).map(([k, v]) => [k, v])),
      })),
      source,
      parentIds: opts.parentIds,
      createdAt: Date.now(),
      sessionId: opts.sessionId,
    };
    this.assets.set(id, { meta, bytes });
    await this.persist(id, bytes);
    return meta;
  }

  async importBytes(bytes: Uint8Array, title: string, sessionId?: string): Promise<MidiAssetMeta> {
    const doc = parseMidi(bytes); // 校验合法
    return this.create(doc, title || '导入的 MIDI', 'uploaded', { sessionId });
  }

  get(id: string): { meta: MidiAssetMeta; bytes: Uint8Array } | undefined {
    const found = this.assets.get(id);
    return found ? { meta: found.meta, bytes: found.bytes } : undefined;
  }

  getDoc(id: string): MidiDocument | undefined {
    const found = this.assets.get(id);
    if (!found) return undefined;
    return parseDocumentSafely(found.bytes);
  }

  list(sessionId?: string): MidiAssetMeta[] {
    const all = [...this.assets.values()].map((a) => a.meta);
    const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
    if (!sessionId) return sorted;
    return sorted.filter((m) => !m.sessionId || m.sessionId === sessionId);
  }

  async remove(id: string): Promise<void> {
    this.assets.delete(id);
    if (this.dir) {
      try {
        await fs.unlink(path.join(this.dir, `${id}.mid`));
      } catch {
        // ignore
      }
      await this.writeIndex();
    }
  }

  private async persist(id: string, bytes: Uint8Array): Promise<void> {
    if (!this.dir) return;
    await fs.writeFile(path.join(this.dir, `${id}.mid`), bytes);
    await this.writeIndex();
  }

  private async writeIndex(): Promise<void> {
    if (!this.dir) return;
    const index = [...this.assets.values()].map((a) => ({ id: a.meta.id, meta: a.meta }));
    await fs.writeFile(path.join(this.dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  }
}
