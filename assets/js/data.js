/* data.js — 词库分片按需加载 + 内存 LRU 缓存
 * 分片文件 site/data/cNNNN.json：{w, ph, rank, books, senses, phrases, usage, ex}
 * 索引 site/data/index.json：{v, count, chunks:[{file, words:[w...]}], map:{w:[chunkIdx, rank, booksBitmask]}}
 * 书 id 位序（bitmask）：hbs=1, slp926=2, lxy=4, sg=8, llyc=16
 */
export const BOOK_BITS = { hbs: 1, slp926: 2, lxy: 4, sg: 8, llyc: 16 };
export const BOOK_NAMES = { hbs: '红宝书', slp926: '核心926', lxy: '你还在背单词吗', sg: '词汇闪过', llyc: '恋练有词' };

let index = null;
let indexPromise = null;
const chunkCache = new Map();          // chunkIdx -> Promise<{words:{w:entry}}>
const LRU_MAX = 12;

export function loadIndex() {
  if (indexPromise) return indexPromise;
  indexPromise = fetch('data/index.json', { cache: 'force-cache' })
    .then(r => { if (!r.ok) throw new Error('index ' + r.status); return r.json(); })
    .then(j => { index = j; return j; })
    .catch(e => { indexPromise = null; throw e; });   // 失败回收，下次重试
  return indexPromise;
}

export function getIndex() { return index; }

export function loadChunk(idx) {
  if (!index) return Promise.reject(new Error('index not loaded'));
  let p = chunkCache.get(idx);
  if (p) {
    // LRU：删除再插入保持新鲜度
    chunkCache.delete(idx);
    chunkCache.set(idx, p);
    return p;
  }
  p = fetch(index.chunks[idx].file, { cache: 'force-cache' }).then(r => r.json());
  chunkCache.set(idx, p);
  if (chunkCache.size > LRU_MAX) {
    const oldest = chunkCache.keys().next().value;
    chunkCache.delete(oldest);
  }
  return p;
}

/** 取单词完整词条（分片对象里带 words map） */
export async function getEntry(word) {
  if (!index) await loadIndex();
  const m = index.map[word];
  if (!m) return null;
  const [ci] = m;
  const chunk = await loadChunk(ci);
  return chunk.words[word] || null;
}

/** 新词队列：按 rank 降序 → tier 高频优先 → 字母序，产出词头数组（懒加载时按块流式产出） */
export function newWordCandidates(state) {
  if (!index) return Promise.reject(new Error('index not loaded'));
  // 生成全局候选序列：按 rank 降序；同 rank 按字母序（块内已排序）
  const order = [];
  const byRank = new Map();     // rank -> [word...]
  for (const [w, m] of Object.entries(index.map)) {
    const rank = m[1];
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(w);
  }
  for (const rank of [...byRank.keys()].sort((a, b) => b - a)) {
    byRank.get(rank).sort();
    order.push(...byRank.get(rank));
  }
  return order.filter(w => !state.shouldSkip(w));
}

/** 词库浏览：按过滤条件返回 [word, rank, booksBitmask] 列表 */
export function browseList({ letter = null, book = null, minRank = 1, q = '' } = {}) {
  if (!index) return [];
  const out = [];
  const ql = q.trim().toLowerCase();
  for (const [w, m] of Object.entries(index.map)) {
    const [ci, rank, mask] = m;
    if (rank < minRank) continue;
    if (book && !(mask & BOOK_BITS[book])) continue;
    if (letter && !w.toLowerCase().startsWith(letter)) continue;
    if (ql && !w.toLowerCase().includes(ql)) continue;
    out.push([w, rank, mask]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

/** 到期词列表（words = state.words 记录表） */
export async function dueWords(words, now = Date.now()) {
  if (!index) await loadIndex();
  const due = Object.entries(words || {}).filter(([w, r]) => (r.dueAt || 0) <= now);
  due.sort((a, b) => (a[1].dueAt || 0) - (b[1].dueAt || 0));
  return due.map(([w]) => w);
}

export function maskToBooks(mask) {
  return Object.keys(BOOK_BITS).filter(b => mask & BOOK_BITS[b]);
}
