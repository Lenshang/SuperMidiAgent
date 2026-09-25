/** 知识库管理：文件/文件夹导入、分块、BM25 检索、持久化。 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { Bm25Index, IndexedChunk } from './bm25';
import { KbSearchResult, KbSource, KbStats } from '../shared/types';

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.log', '.lrc', '.srt', '.vtt',
  '.xml', '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py',
  '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sql', '.midi.txt',
]);

const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 120;

interface KbPersistShape {
  sources: KbSource[];
  chunks: (IndexedChunk & { enabled: boolean })[];
}

export class KnowledgeBase {
  private index = new Bm25Index();
  private sources: KbSource[] = [];
  private chunks = new Map<string, IndexedChunk & { enabled: boolean }>();

  constructor(private dir: string | null) {}

  async init(): Promise<void> {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(path.join(this.dir, 'index.json'), 'utf8');
      const data: KbPersistShape = JSON.parse(raw);
      this.sources = data.sources ?? [];
      for (const chunk of data.chunks ?? []) {
        this.chunks.set(chunk.id, chunk);
        if (chunk.enabled) this.index.add(chunk);
      }
    } catch {
      this.sources = [];
    }
  }

  getStats(): KbStats {
    return {
      sources: [...this.sources],
      totalChunks: [...this.chunks.values()].filter((c) => c.enabled).length,
      topK: 4,
    };
  }

  async addPaths(paths: string[]): Promise<KbSource[]> {
    const added: KbSource[] = [];
    for (const p of paths) {
      const stat = await fs.stat(p).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) added.push(await this.addFolder(p));
      else added.push(await this.addFile(p));
    }
    await this.persist();
    return added;
  }

  private async addFolder(folder: string): Promise<KbSource> {
    const sourceId = randomUUID().slice(0, 8);
    const source: KbSource = { id: sourceId, path: folder, kind: 'folder', fileCount: 0, chunkCount: 0, enabled: true };
    const files = await this.walk(folder);
    let chunks = 0;
    for (const file of files) {
      chunks += await this.ingestFile(file, sourceId);
    }
    source.fileCount = files.length;
    source.chunkCount = chunks;
    this.sources.push(source);
    return source;
  }

  private async addFile(file: string): Promise<KbSource> {
    const sourceId = randomUUID().slice(0, 8);
    const source: KbSource = { id: sourceId, path: file, kind: 'file', fileCount: 1, chunkCount: 0, enabled: true };
    source.chunkCount = await this.ingestFile(file, sourceId);
    this.sources.push(source);
    return source;
  }

  private async walk(dir: string, depth = 0): Promise<string[]> {
    if (depth > 6) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await this.walk(full, depth + 1)));
      else if (TEXT_EXTS.has(path.extname(entry.name).toLowerCase()) || /\.pdf$/i.test(entry.name)) files.push(full);
    }
    return files;
  }

  private async ingestFile(file: string, sourceId: string): Promise<number> {
    try {
      let text: string;
      if (/\.pdf$/i.test(file)) {
        text = await this.extractPdf(file);
      } else if (!TEXT_EXTS.has(path.extname(file).toLowerCase())) {
        return 0;
      } else {
        const raw = await fs.readFile(file, 'utf8');
        text = raw;
      }
      if (!text.trim()) return 0;
      const title = path.basename(file);
      const pieces = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
      pieces.forEach((piece, i) => {
        const chunk: IndexedChunk & { enabled: boolean } = {
          id: `${sourceId}-${i}`,
          sourceId,
          sourcePath: file,
          title,
          chunkIndex: i,
          text: piece,
          enabled: true,
        };
        this.chunks.set(chunk.id, chunk);
        this.index.add(chunk);
      });
      return pieces.length;
    } catch (err) {
      const source = this.sources.find((s) => s.id === sourceId);
      if (source) source.error = `${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`;
      return 0;
    }
  }

  private async extractPdf(file: string): Promise<string> {
    // pdf-parse 的入口在直接 require 时会执行调试逻辑，绕开它直接加载 lib
    const require = createRequire(import.meta.url);
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (buf: Buffer) => Promise<{ text: string }>;
    const data = await fs.readFile(file);
    const result = await pdfParse(data);
    return result.text;
  }

  async removeSource(sourceId: string): Promise<void> {
    this.sources = this.sources.filter((s) => s.id !== sourceId);
    for (const [id, chunk] of [...this.chunks]) {
      if (chunk.sourceId === sourceId) {
        this.chunks.delete(id);
        this.index.remove(id);
      }
    }
    await this.persist();
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const source = this.sources.find((s) => s.id === sourceId);
    if (!source) return;
    source.enabled = enabled;
    for (const chunk of this.chunks.values()) {
      if (chunk.sourceId !== sourceId) continue;
      chunk.enabled = enabled;
      if (enabled) this.index.add(chunk);
      else this.index.remove(chunk.id);
    }
    await this.persist();
  }

  async rebuild(): Promise<void> {
    const paths = this.sources.map((s) => s.path);
    this.sources = [];
    this.chunks.clear();
    this.index = new Bm25Index();
    await this.addPaths(paths);
  }

  search(query: string, topK = 4): KbSearchResult[] {
    return this.index.search(query, topK).map(({ doc, score }) => ({
      sourcePath: doc.sourcePath,
      title: doc.title,
      chunkIndex: doc.chunkIndex,
      score: Math.round(score * 100) / 100,
      text: doc.text.length > 600 ? `${doc.text.slice(0, 600)}…` : doc.text,
    }));
  }

  private async persist(): Promise<void> {
    if (!this.dir) return;
    const data: KbPersistShape = {
      sources: this.sources,
      chunks: [...this.chunks.values()],
    };
    await fs.writeFile(path.join(this.dir, 'index.json'), JSON.stringify(data), 'utf8');
  }
}

/** 分块：优先按标题/空行切分，合并到目标大小，带重叠。 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= size) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let buffer = '';
  for (const para of paragraphs) {
    if (para.length > size) {
      // 超长段落按句子/硬切
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = '';
      }
      for (let i = 0; i < para.length; i += size - overlap) {
        chunks.push(para.slice(i, i + size));
      }
      continue;
    }
    if (buffer.length + para.length + 2 > size) {
      chunks.push(buffer.trim());
      const tail = buffer.slice(Math.max(0, buffer.length - overlap));
      buffer = `${tail}\n\n${para}`;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks.filter((c) => c.length > 20);
}
