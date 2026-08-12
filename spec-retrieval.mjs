// 答疑 Spec 两阶段召回纯逻辑：
// ① 用完整文档目录、frontmatter、标题层级和精确标识符路由候选文件；
// ② 只在候选文件正文内切片、排序并产出事实证据。
// 本模块不碰数据库、模型或网络，server.mjs 负责只读加载 Spec 后调用。

const API_RE = /\/(?:api|pwrsapi|proxyapi|applet|comm|html|word|config|pharmacist)(?:\/[A-Za-z0-9_.{}:?=&%+-]+)+/g;
const STRUCT_IDENT_RE = /\b(?:[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{2,}[0-9]*)\b/g;
const QUERY_WORD_RE = /\b[A-Za-z][A-Za-z0-9_.-]*\b/g;
const INLINE_CODE_RE = /`([^`\n]{1,160})`/g;
const DATA_QUERY_RE = /表|字段|库|数据库|入库|存哪|哪张|落库|column|schema|table|field/i;
const API_QUERY_RE = /接口|api|调用|请求|端点|endpoint|url|路径/i;
const DATA_BODY_RE = /数据契约|主表|列名|varchar|char\(|bigint|\bPK\b|表结构/i;
const API_BODY_RE = /接口契约|\b(?:GET|POST|PUT|DELETE|PATCH)\s+\//i;
const GENERIC_QUERY_IDENTIFIERS = new Set(['sql', 'pwrs', 'web', 'postgresql', 'mysql', 'oracle', 'http', 'https', 'api', 'etl', 'his', 'jwt', 'json', 'java', 'vue', 'websocket']);

function uniq(list) { return [...new Set(list.filter(Boolean))]; }
function frontmatter(text) {
  const m = String(text || '').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function cjkGroups(text) { return String(text || '').match(/[一-鿿]+/g) || []; }

export function retrievalTokens(text) {
  const out = [];
  for (const group of cjkGroups(text)) {
    if (group.length === 1) out.push(group);
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= group.length; i++) out.push(group.slice(i, i + n));
  }
  for (const word of (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [])) if (word.length > 1) out.push(word);
  return uniq(out);
}

function identifiersFrom(text, includePlainWords = false) {
  const src = String(text || '');
  const out = [];
  for (const re of [API_RE, STRUCT_IDENT_RE]) {
    re.lastIndex = 0;
    let m; while ((m = re.exec(src))) out.push(m[0].replace(/[.,;:]+$/, ''));
  }
  INLINE_CODE_RE.lastIndex = 0;
  let code;
  while ((code = INLINE_CODE_RE.exec(src))) {
    const raw = code[1].trim();
    if (/^(?:\/?[A-Za-z][A-Za-z0-9_./?=&{}:-]*|[A-Z][A-Z0-9_]+)$/.test(raw)) out.push(raw);
  }
  if (includePlainWords) {
    QUERY_WORD_RE.lastIndex = 0;
    let word; while ((word = QUERY_WORD_RE.exec(src))) if (/^[a-z][a-z0-9.-]{3,}$/.test(word[0])) out.push(word[0]);
  }
  const values = uniq(out);
  return includePlainWords ? values.filter(x => !GENERIC_QUERY_IDENTIFIERS.has(String(x).toLowerCase())) : values;
}

function headingCatalog(text) {
  const stack = [];
  const headings = [];
  for (const line of String(text || '').replace(/^\uFEFF?---[\s\S]*?---\s*/, '').split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/); if (!m) continue;
    const level = m[1].length, title = m[2].replace(/\s+#+\s*$/, '').trim();
    stack.length = level - 1; stack[level - 1] = title;
    headings.push(stack.filter(Boolean).join(' › '));
  }
  return headings;
}

export function buildSpecDocument(input) {
  const text = String((input && input.text) || '');
  const fm = frontmatter(text);
  const file = String((input && input.file) || '');
  const title = String((input && input.title) || fm.title || file.split('/').pop() || '').replace(/\.md$/i, '').trim();
  const module = String((input && input.module) || fm.module || '').trim();
  const id = String((input && input.id) || fm.id || '').trim();
  const subsystem = String((input && input.subsystem) || '').trim();
  const headings = headingCatalog(text);
  // identifiers 可从正文抽取，但只进入“机器路由索引”：它们帮助把精确 API/字段路由到文件，
  // 从不直接返回模型；模型事实证据仍只能来自第二阶段命中的正文片段。
  const identifiers = identifiersFrom(text, false);
  const routeText = [id, title, module, subsystem, file, ...headings, ...identifiers].join('\n');
  return { file, id, title, module, subsystem, headings, identifiers, routeText, text };
}

function ensureDoc(raw, i) {
  if (raw && Array.isArray(raw.headings) && Array.isArray(raw.identifiers) && typeof raw.routeText === 'string') return raw;
  return buildSpecDocument({ ...(raw || {}), file: (raw && raw.file) || `spec-${i + 1}.md` });
}

function exactScore(queryIds, doc) {
  if (!queryIds.length) return 0;
  const exact = new Set(doc.identifiers || []);
  const folded = new Set([...(doc.identifiers || []), doc.id, doc.title].filter(Boolean).map(x => String(x).toLowerCase()));
  let score = 0;
  for (const q of queryIds) {
    if (exact.has(q)) score += q.startsWith('/') ? 220 : 120;
    else if (q.length >= 3 && folded.has(q.toLowerCase())) score += q.startsWith('/') ? 140 : 35;
  }
  return score;
}

export function routeSpecCandidates(rawDocs, query, options = {}) {
  const docs = (Array.isArray(rawDocs) ? rawDocs : []).map(ensureDoc);
  if (!docs.length || !String(query || '').trim()) return [];
  const subKey = String(options.subKey || '').trim();
  let scope = docs;
  if (subKey) {
    const narrowed = docs.filter(d => d.subsystem === subKey);
    if (narrowed.length) scope = narrowed;
  }
  const qTokens = retrievalTokens(query), qIds = identifiersFrom(query, true);
  const tokenSets = scope.map(d => new Set(retrievalTokens(d.routeText)));
  const df = new Map();
  for (const set of tokenSets) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  const weight = t => Math.log(1 + (scope.length + 1) / ((df.get(t) || 0) + 0.5)) * (t.length >= 4 ? 1.7 : 1);
  const ranked = scope.map((d, i) => {
    const titleSet = new Set(retrievalTokens([d.id, d.title, d.module, d.subsystem].join(' ')));
    const headingSet = new Set(retrievalTokens((d.headings || []).join(' ')));
    let score = exactScore(qIds, d), matched = 0;
    for (const t of qTokens) if (tokenSets[i].has(t)) {
      const w = weight(t); matched++;
      score += w * (titleSet.has(t) ? 5 : (headingSet.has(t) ? 2.2 : 1));
    }
    return { ...d, routeScore: score, routeMatched: matched };
  }).filter(x => x.routeScore > 0).sort((a, b) => b.routeScore - a.routeScore || b.routeMatched - a.routeMatched || a.file.localeCompare(b.file));
  const max = Math.max(1, Math.min(24, Number(options.maxCandidates) || 12));
  return ranked.slice(0, max);
}

function sectionBlocks(text) {
  const body = String(text || '').replace(/^\uFEFF?---[\s\S]*?---\s*/, '');
  const stack = [], sections = [];
  let heading = '', lines = [];
  const flush = () => {
    const content = lines.join('\n').trim();
    if (content) sections.push({ heading: heading || '正文', content });
    lines = [];
  };
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) { lines.push(line); continue; }
    flush();
    const level = m[1].length, title = m[2].replace(/\s+#+\s*$/, '').trim();
    stack.length = level - 1; stack[level - 1] = title;
    heading = stack.filter(Boolean).join(' › ');
  }
  flush();
  return sections;
}

function splitSection(section, target = 1000, overlap = 180) {
  const prefix = `### ${section.heading}\n`;
  const lines = section.content.split('\n');
  const blocks = [];
  let buf = [];
  const push = () => {
    const value = buf.join('\n').trim();
    if (value) blocks.push({ heading: section.heading, text: prefix + value });
  };
  for (const sourceLine of lines) {
    const pieces = [];
    if (sourceLine.length <= target) pieces.push(sourceLine);
    else for (let i = 0; i < sourceLine.length; i += Math.max(1, target - overlap)) pieces.push(sourceLine.slice(i, i + target));
    for (const line of pieces) {
      const next = [...buf, line].join('\n');
      if (buf.length && next.length > target) {
        push();
        const tail = buf.join('\n').slice(-overlap);
        buf = tail ? [tail, line] : [line];
      } else buf.push(line);
    }
  }
  push();
  return blocks;
}

export function chunkSpecDocument(rawDoc) {
  const doc = ensureDoc(rawDoc, 0);
  const out = [];
  for (const section of sectionBlocks(doc.text)) for (const block of splitSection(section)) out.push({
    file: doc.file,
    id: doc.id,
    subsystem: doc.subsystem,
    module: doc.module,
    title: doc.title,
    heading: block.heading,
    text: block.text,
    evidence: 'body',
  });
  return out;
}

function chunkExactScore(queryIds, text) {
  let score = 0, count = 0;
  for (const id of queryIds) {
    if (String(text).includes(id)) { score += id.startsWith('/') ? 260 : 150; count++; }
    // 小写参数名（如 word）保持大小写精确，避免把它错认成产品词 Word；
    // API/全大写/驼峰等结构标识仍允许大小写降级匹配。
    else if (id.length >= 3 && !/^[a-z][a-z0-9.-]*$/.test(id) && String(text).toLowerCase().includes(id.toLowerCase())) { score += id.startsWith('/') ? 160 : 45; count++; }
  }
  return { score, count };
}

export function searchSpecDocuments(rawDocs, query, options = {}) {
  const n = Math.max(1, Math.min(10, Number(options.n) || 5));
  const candidates = routeSpecCandidates(rawDocs, query, options);
  if (!candidates.length) return { candidates: [], hits: [] };
  const qTokens = retrievalTokens(query), qIds = identifiersFrom(query, true);
  const chunks = candidates.flatMap(chunkSpecDocument);
  const sets = chunks.map(c => new Set(retrievalTokens(`${c.heading}\n${c.text}`)));
  const df = new Map();
  for (const set of sets) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  const weight = t => Math.log(1 + (chunks.length + 1) / ((df.get(t) || 0) + 0.5)) * (t.length >= 4 ? 1.8 : 1);
  const routeByFile = new Map(candidates.map(c => [c.file, c.routeScore || 0]));
  const maxRoute = Math.max(1, ...routeByFile.values());
  const tableQ = DATA_QUERY_RE.test(query), apiQ = API_QUERY_RE.test(query);
  const ranked = chunks.map((c, i) => {
    let lexical = 0; const matchedTerms = [];
    for (const t of qTokens) if (sets[i].has(t)) { lexical += weight(t); matchedTerms.push(t); }
    const exact = chunkExactScore(qIds, c.text);
    let relevanceScore = exact.score + lexical;
    if (tableQ && DATA_BODY_RE.test(c.text)) relevanceScore += 9;
    if (apiQ && API_BODY_RE.test(c.text)) relevanceScore += 9;
    const score = relevanceScore + 12 * ((routeByFile.get(c.file) || 0) / maxRoute);
    return { ...c, score, relevanceScore, exactMatches: exact.count, matched: matchedTerms.length, matchedTerms };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || b.exactMatches - a.exactMatches || a.file.localeCompare(b.file));

  // 小型 MMR：每文件最多 3 段；已入选文件轻微降权，让 Top5 有文件多样性，
  // 但精确路径/字段的高分片段仍可从同一正确文件占 2~3 个预算。
  const topScore = ranked.length ? ranked[0].score : 0;
  const topRelevance = ranked.length ? Math.max(...ranked.map(c => c.relevanceScore || 0)) : 0;
  const topHasExact = !!(ranked[0] && ranked[0].exactMatches);
  // 有精确标识符时，拒绝只蹭“连接/记录/完成”等常见词的低分片段；
  // 无精确标识符的自然中文问法仍保留较宽松阈值，由标题/模块路由分承担消歧。
  const relevant = ranked.filter(c => c.exactMatches || (
    c.score >= Math.max(2, topScore * (topHasExact ? 0.12 : 0.08))
    && c.relevanceScore >= Math.max(1.5, topRelevance * (topHasExact ? 0.08 : 0.18))
    && (routeByFile.get(c.file) || 0) >= maxRoute * (topHasExact ? 0.12 : 0.18)
  ));
  const pool = relevant.slice(), hits = [], perFile = new Map();
  while (pool.length && hits.length < n) {
    let best = -1, bestAdjusted = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const used = perFile.get(pool[i].file) || 0;
      if (used >= 3) continue;
      const adjusted = pool[i].score * (used ? 0.78 : 1);
      if (adjusted > bestAdjusted) { bestAdjusted = adjusted; best = i; }
    }
    if (best < 0) break;
    const [pick] = pool.splice(best, 1);
    perFile.set(pick.file, (perFile.get(pick.file) || 0) + 1);
    hits.push(pick);
  }
  return { candidates, hits };
}

export function currentTurnEvidenceGuard(query, hits) {
  const entities = uniq((Array.isArray(hits) ? hits : []).flatMap(h => [h && h.module, h && h.title]).map(x => String(x || '').trim())).slice(0, 8);
  return [
    '【本轮事实边界】',
    `当前问题：${String(query || '').trim().slice(0, 1200)}`,
    `当前召回实体：${entities.length ? entities.join('、') : '无可用规格正文证据'}`,
    '回答当前问题时，只能把本轮“相关规格摘录”和经验/源码片段中的正文当作事实证据；规格目录标题只用于导航，不能据此补写规则。',
    '历史对话只用于理解追问和代词，不能把历史中其它模块的事实迁移成当前问题的事实证据。若本轮正文没有证据，继续安全说明当前资料无法确认。',
  ].join('\n');
}
