import { describe, expect, it, beforeEach } from 'vitest';
import { Bm25Index, tokenize } from '../src/main/bm25';
import { chunkText } from '../src/main/knowledgeBase';

describe('分词', () => {
  it('拉丁词小写化', () => {
    expect(tokenize('Hello World MIDI_File')).toEqual(['hello', 'world', 'midi_file']);
  });

  it('中文单字与二元组', () => {
    const tokens = tokenize('和弦生成');
    expect(tokens).toContain('和弦');
    expect(tokens).toContain('弦生');
    expect(tokens).toContain('生成');
    expect(tokens).toContain('和');
  });

  it('中英混合', () => {
    const tokens = tokenize('CC11 控制器 expression');
    expect(tokens).toContain('cc11');
    expect(tokens).toContain('expression');
    expect(tokens).toContain('控制');
  });
});

describe('BM25', () => {
  let index: Bm25Index;

  beforeEach(() => {
    index = new Bm25Index();
    index.add({ id: '1', sourceId: 's1', sourcePath: 'a.md', title: 'a', chunkIndex: 0, text: 'MIDI 文件由多个轨道组成，每个轨道包含音符与控制器事件' });
    index.add({ id: '2', sourceId: 's1', sourcePath: 'b.md', title: 'b', chunkIndex: 0, text: 'CC11 是表情控制器，用于控制音量的强弱起伏，常用于弦乐' });
    index.add({ id: '3', sourceId: 's2', sourcePath: 'c.md', title: 'c', chunkIndex: 0, text: '今天天气很好，适合出门散步' });
  });

  it('相关文档排在前面', () => {
    const results = index.search('CC11 表情控制器', 3);
    expect(results[0].doc.id).toBe('2');
  });

  it('中文查询命中', () => {
    const results = index.search('轨道 音符', 3);
    expect(results[0].doc.id).toBe('1');
  });

  it('无关查询不返回垃圾', () => {
    const results = index.search('散步', 3);
    expect(results[0].doc.id).toBe('3');
  });

  it('删除文档后不再命中', () => {
    index.remove('2');
    const results = index.search('CC11 表情', 3);
    expect(results.find((r) => r.doc.id === '2')).toBeUndefined();
  });
});

describe('chunkText 分块', () => {
  it('短文本不分块', () => {
    expect(chunkText('很短的文本', 700, 120)).toHaveLength(1);
  });

  it('长文本按段落合并分块', () => {
    const para = '这是一段关于 MIDI 制作的知识。'.repeat(8); // ~240 chars
    const text = Array.from({ length: 8 }, (_, i) => `第${i}章\n\n${para}`).join('\n\n');
    const chunks = chunkText(text, 700, 120);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 900)).toBe(true);
    // 重叠：相邻块应有部分内容衔接
    expect(chunks[1].length).toBeGreaterThan(100);
  });

  it('超长无段落文本硬切', () => {
    const text = 'x'.repeat(2000);
    const chunks = chunkText(text, 700, 120);
    expect(chunks.length).toBe(4); // 步长 580
    expect(chunks[0].length).toBe(700);
  });
});
