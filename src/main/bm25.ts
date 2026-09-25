/** BM25 检索：支持中英文混合分词（拉丁词 + CJK 单字与二元组）。 */

export interface IndexedChunk {
  id: string;
  sourceId: string;
  sourcePath: string;
  title: string;
  chunkIndex: number;
  text: string;
}

interface DocTermInfo {
  tf: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private docs: IndexedChunk[] = [];
  private docTerms: DocTermInfo[] = [];
  private df = new Map<string, number>();
  private totalLength = 0;

  constructor(private k1 = 1.5, private b = 0.75) {}

  get size(): number {
    return this.docs.length;
  }

  add(doc: IndexedChunk): void {
    this.remove(doc.id);
    const tf = new Map<string, number>();
    const tokens = tokenize(doc.text);
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.push(doc);
    this.docTerms.push({ tf, length: tokens.length });
    this.totalLength += tokens.length;
    for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
  }

  remove(id: string): void {
    const idx = this.docs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const [doc] = this.docs.splice(idx, 1);
    const [terms] = this.docTerms.splice(idx, 1);
    this.totalLength -= terms.length;
    for (const term of terms.tf.keys()) {
      const count = (this.df.get(term) ?? 1) - 1;
      if (count <= 0) this.df.delete(term);
      else this.df.set(term, count);
    }
    void doc;
  }

  search(query: string, topK = 4): { doc: IndexedChunk; score: number }[] {
    if (this.docs.length === 0) return [];
    const avgLen = this.totalLength / this.docs.length || 1;
    const queryTerms = Array.from(new Set(tokenize(query)));
    const scores: { doc: IndexedChunk; score: number }[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      const { tf, length } = this.docTerms[i];
      let score = 0;
      for (const term of queryTerms) {
        const f = tf.get(term);
        if (!f) continue;
        const n = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * length) / avgLen)));
      }
      if (score > 0) scores.push({ doc: this.docs[i], score });
    }
    return scores.sort((a, b2) => b2.score - a.score).slice(0, topK);
  }
}

/** 分词：拉丁字母/数字词（小写化）+ CJK 逐字与二元组。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  const re = /([a-z0-9_]+)|([\u4e00-\u9fff\u3400-\u4dbf])/gu;
  let match: RegExpExecArray | null;
  const cjkChars: string[] = [];
  const flushCjk = () => {
    for (let i = 0; i < cjkChars.length; i++) {
      tokens.push(cjkChars[i]);
      if (i + 1 < cjkChars.length) tokens.push(cjkChars[i] + cjkChars[i + 1]);
    }
    cjkChars.length = 0;
  };
  while ((match = re.exec(lower)) !== null) {
    if (match[1]) {
      flushCjk();
      tokens.push(match[1]);
    } else {
      cjkChars.push(match[2]);
    }
  }
  flushCjk();
  return tokens;
}
