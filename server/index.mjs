import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const port = Number(process.env.PORT || 5173);
const knowledgeIndexPath = resolve(root, 'knowledge', 'index.jsonl');
const knowledgeMetaPath = resolve(root, 'knowledge', 'index.meta.json');

loadDotEnv(resolve(root, '.env'));

const knowledge = loadKnowledgeIndex();

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/status', (_req, res) => {
  res.json({
    configured: hasDeepSeekKey(),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    knowledge: {
      ready: knowledge.chunks.length > 0,
      chunkCount: knowledge.chunks.length,
      books: knowledge.meta?.books || []
    }
  });
});

app.post('/api/analyze', async (req, res) => {
  const { text, context } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim().length < 4) {
    return res.status(400).json({ error: '截图文字太少，请重新上传更清晰的截图，或手动补充谈判内容。' });
  }

  const retrieved = retrieveKnowledge(`${context || ''}\n${text}`, 8);

  if (!hasDeepSeekKey()) {
    return res.json(buildLocalAnalysis(text, retrieved));
  }

  try {
    const result = await analyzeWithDeepSeek(text, context, retrieved);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: 'DeepSeek 分析暂时失败，聊天内容已保留，你可以稍后重试。',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/context-chat', async (req, res) => {
  const { messages, currentContext } = req.body || {};
  const history = arrayOr(messages)
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      text: stringOr(item?.text, '')
    }))
    .filter((item) => item.text);

  const latest = history.at(-1)?.text || '';
  if (!latest || latest.length < 2) {
    return res.status(400).json({ error: '请先输入背景、目标、底线，或上传背景截图。' });
  }

  const retrieved = retrieveKnowledge(`${currentContext || ''}\n${history.map((item) => item.text).join('\n')}`, 6);

  if (!hasDeepSeekKey()) {
    return res.json(buildLocalContextReply(history, currentContext, retrieved));
  }

  try {
    const result = await contextChatWithDeepSeek(history, currentContext, retrieved);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: 'DeepSeek 背景对话暂时失败，内容已保留，你可以稍后重试。',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

if (!isProduction) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root,
    server: {
      middlewareMode: true,
      allowedHosts: ['.trycloudflare.com']
    },
    appType: 'spa'
  });
  app.use(vite.middlewares);
} else {
  const dist = resolve(root, 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Negotiation assistant running at http://127.0.0.1:${port}/`);
  console.log(`Knowledge index: ${knowledge.chunks.length ? `${knowledge.chunks.length} chunks loaded` : 'not built'}`);
});

async function analyzeWithDeepSeek(text, context = '', retrieved = []) {
  const sourcesBlock = formatSourcesForPrompt(retrieved);
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      temperature: 0.25,
      thinking: { type: process.env.DEEPSEEK_THINKING || 'enabled' },
      reasoning_effort: process.env.DEEPSEEK_REASONING_EFFORT || 'high',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '你是一个中文谈判教练。你必须基于用户提供的谈判内容和“本地书籍知识库摘录”给出建议。每一个陷阱判断、回复建议、追问或底线都必须尽量附上来源编号。只输出 JSON，不要输出 Markdown。不要编造书名、页码或来源编号；只能使用用户消息中给出的来源编号。'
        },
        {
          role: 'user',
          content: `请分析以下谈判内容，识别话术陷阱、信息不对称、压力测试、锚定、稀缺性、模糊承诺、单方让步、假二选一、时间压力和情绪勒索，并给出可直接参考的中文回应。

上下文：
${context || '无'}

谈判内容：
${text}

本地书籍知识库摘录：
${sourcesBlock}

输出 JSON 字段必须为：
{
  "summary": "一句话概括局面",
  "overallRisk": "低|中|高",
  "traps": [{"name":"陷阱名称","risk":"低|中|高","evidence":"引用或概括对方话术","why":"为什么危险","counter":"用户该怎么判断和接话","sourceIds":["S1"]}],
  "responses": [{"tone":"稳健|强硬|缓和","text":"可直接复制或参考的中文回应","sourceIds":["S1"]}],
  "nextQuestions": ["继续谈判前该问清的问题"],
  "boundaries": ["要守住的底线"],
  "citations": [{"id":"S1","title":"书名","author":"作者","page":12,"principle":"用中文概括该来源支持的原则，不要大段引用原文"}]
}

引用要求：
1. 每条 traps 和 responses 至少放 1 个 sourceIds；如果知识库摘录不足，只使用最相关的来源。
2. citations 只列实际使用过的来源编号。
3. principle 必须是中文转述，不要长篇摘抄。`
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 没有返回内容。');
  return normalizeAnalysis(JSON.parse(content), text, retrieved);
}

async function contextChatWithDeepSeek(history, currentContext = '', retrieved = []) {
  const sourcesBlock = formatSourcesForPrompt(retrieved);
  const conversation = history.map((item) => `${item.role === 'user' ? '用户' : '助手'}：${item.text}`).join('\n');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      temperature: 0.3,
      thinking: { type: process.env.DEEPSEEK_THINKING || 'enabled' },
      reasoning_effort: process.env.DEEPSEEK_REASONING_EFFORT || 'high',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '你是一个中文谈判背景梳理教练。你的任务是和用户深入聊天，帮助用户把谈判背景、目标、底线、对方约束、可交换条件和风险点讲清楚。必须基于给出的本地书籍知识库摘录提供追问或建议。只输出 JSON，不要 Markdown。不要编造来源编号。'
        },
        {
          role: 'user',
          content: `当前已整理背景：
${currentContext || '无'}

背景对话历史：
${conversation}

本地书籍知识库摘录：
${sourcesBlock}

请输出 JSON：
{
  "reply": "你对用户的自然中文回复。可以追问，也可以帮用户整理条件；不要太长。",
  "updatedContext": "把到目前为止已经明确的背景条件整理成简洁摘要。保留目标、底线、对方身份、关键约束、可交换条件和未决问题。",
  "citations": [{"id":"S1","title":"书名","author":"作者","page":12,"principle":"中文转述该来源支持的原则"}]
}

引用要求：
1. reply 中涉及谈判建议、追问方向或框架时，citations 至少列 1 个来源。
2. citations 只列实际使用过的来源编号。
3. principle 必须中文转述，不要长篇摘抄。`
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 没有返回内容。');
  return normalizeContextReply(JSON.parse(content), currentContext, retrieved);
}

function hasDeepSeekKey() {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  return Boolean(key && key !== 'your_deepseek_api_key_here' && key.startsWith('sk-'));
}

function normalizeAnalysis(payload, sourceText, retrieved = []) {
  const available = buildCitationCatalog(retrieved);
  const citations = normalizeCitations(payload.citations, available);
  const fallbackSourceIds = citations.slice(0, 2).map((item) => item.id);

  return {
    summary: stringOr(payload.summary, '已识别谈判内容，请结合原文确认关键信息。'),
    overallRisk: riskOr(payload.overallRisk, '中'),
    traps: arrayOr(payload.traps).slice(0, 6).map((item) => ({
      name: stringOr(item.name, '潜在话术陷阱'),
      risk: riskOr(item.risk, '中'),
      evidence: stringOr(item.evidence, sourceText.slice(0, 80)),
      why: stringOr(item.why, '这可能让你在信息不足时做出承诺。'),
      counter: stringOr(item.counter, '先确认事实、条件和退出机制，再回应对方。'),
      sourceIds: sourceIdsOr(item.sourceIds, fallbackSourceIds)
    })),
    responses: arrayOr(payload.responses).slice(0, 4).map((item) => ({
      tone: stringOr(item.tone, '稳健'),
      text: stringOr(item.text, '我需要先确认关键条件，再决定下一步。'),
      sourceIds: sourceIdsOr(item.sourceIds, fallbackSourceIds)
    })),
    nextQuestions: arrayOr(payload.nextQuestions).slice(0, 6).map((item) => String(item)),
    boundaries: arrayOr(payload.boundaries).slice(0, 6).map((item) => String(item)),
    citations,
    source: 'deepseek'
  };
}

function buildLocalAnalysis(text, retrieved = []) {
  const compact = text.replace(/\s+/g, ' ').trim();
  const citations = buildCitationCatalog(retrieved).slice(0, 4);
  const fallbackSourceIds = citations.slice(0, 2).map((item) => item.id);
  const patterns = [
    { name: '时间压力', hit: /今天|马上|现在|立刻|过期|最后|赶紧/.test(text), risk: '中', why: '时间压力会缩短你核对条件和比较方案的空间。' },
    { name: '模糊承诺', hit: /差不多|应该|大概|以后|回头|尽量|看情况/.test(text), risk: '中', why: '模糊词会让责任和交付标准变得不可追踪。' },
    { name: '单方让步', hit: /你先|先给|先做|先付|先签|诚意/.test(text), risk: '高', why: '对方要求你先投入，却没有给出对等交换或保障。' },
    { name: '假二选一', hit: /要么|只能|不然|否则|二选一/.test(text), risk: '中', why: '把选项压缩成两个，容易掩盖更好的第三方案。' },
    { name: '锚定价格', hit: /价格|报价|预算|便宜|贵|折扣|最低/.test(text), risk: '中', why: '先抛出的数字会影响你对合理区间的判断。' }
  ];
  const traps = patterns
    .filter((item) => item.hit)
    .map((item) => ({
      name: item.name,
      risk: item.risk,
      evidence: compact.slice(0, 120),
      why: item.why,
      counter: '先把条件、期限、交付标准和对等交换写清楚，再决定是否推进。',
      sourceIds: fallbackSourceIds
    }));

  if (traps.length === 0) {
    traps.push({
      name: '信息不足',
      risk: '中',
      evidence: compact.slice(0, 120),
      why: '当前文字没有足够上下文，容易误判对方真实诉求。',
      counter: '先追问目标、期限、可接受条件和不可变约束。',
      sourceIds: fallbackSourceIds
    });
  }

  return {
    summary: citations.length
      ? '当前为本地规则分析，并已附上本地书籍知识库来源。配置 DeepSeek API Key 后可获得更细判断。'
      : '当前为本地规则分析。请先运行 npm.cmd run knowledge:build 生成书籍知识库索引。',
    overallRisk: traps.some((item) => item.risk === '高') ? '高' : '中',
    traps,
    responses: [
      {
        tone: '稳健',
        text: '我可以继续推进，但需要先把关键条件确认清楚：范围、时间、交付标准、费用或回报，以及条件变化时怎么处理。',
        sourceIds: fallbackSourceIds
      },
      {
        tone: '强硬',
        text: '在条件没有写清楚前，我不能先做单方承诺。我们可以把双方各自要承担的部分列出来，再谈下一步。',
        sourceIds: fallbackSourceIds
      },
      {
        tone: '缓和',
        text: '我理解你想快点定下来。为了避免后面反复，我们先把几个关键点对齐，我再给你明确答复。',
        sourceIds: fallbackSourceIds
      }
    ],
    nextQuestions: ['对方要求你先承诺什么？', '对方给出的交换条件是什么？', '是否有明确期限、标准和退出方式？'],
    boundaries: ['不在信息不足时承诺', '不接受只有你单方投入的安排', '所有关键条件落到文字'],
    citations,
    source: 'local'
  };
}

function buildLocalContextReply(history, currentContext = '', retrieved = []) {
  const latest = history.at(-1)?.text || '';
  const citations = buildCitationCatalog(retrieved).slice(0, 3);
  const updatedContext = mergeContextSummary(currentContext, latest);

  return {
    reply:
      '我先把这段背景记下来。继续补充三类信息会更利于后续判断：你的最终目标是什么、不能让步的底线是什么、对方现在最在意或最受约束的点是什么。',
    updatedContext,
    citations,
    source: 'local'
  };
}

function normalizeContextReply(payload, currentContext, retrieved = []) {
  const available = buildCitationCatalog(retrieved);
  return {
    reply: stringOr(payload.reply, '我已经记录这段背景。可以继续告诉我你的目标、底线和对方约束。'),
    updatedContext: stringOr(payload.updatedContext, currentContext || ''),
    citations: normalizeCitations(payload.citations, available),
    source: 'deepseek'
  };
}

function mergeContextSummary(currentContext, latest) {
  const parts = [currentContext, latest].map((item) => String(item || '').trim()).filter(Boolean);
  return Array.from(new Set(parts)).join('\n');
}

function loadKnowledgeIndex() {
  const chunks = [];
  let meta = null;

  if (existsSync(knowledgeIndexPath)) {
    const lines = readFileSync(knowledgeIndexPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line);
        chunks.push({ ...chunk, termSet: new Set(chunk.terms || []) });
      } catch {
        // Skip malformed local index lines.
      }
    }
  }

  if (existsSync(knowledgeMetaPath)) {
    try {
      meta = JSON.parse(readFileSync(knowledgeMetaPath, 'utf8'));
    } catch {
      meta = null;
    }
  }

  return { chunks, meta };
}

function retrieveKnowledge(query, limit = 8) {
  if (!knowledge.chunks.length) return [];
  const terms = expandQueryTerms(query);
  const scored = [];

  for (const chunk of knowledge.chunks) {
    let score = 0;
    for (const term of terms) {
      if (chunk.termSet.has(term)) score += term.length > 6 ? 3 : 1;
      if (chunk.title.toLowerCase().includes(term)) score += 2;
    }
    if (score > 0) scored.push({ chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  const groups = new Map();
  for (const item of scored) {
    const group = groups.get(item.chunk.bookId) || [];
    group.push(item);
    groups.set(item.chunk.bookId, group);
  }

  for (const group of groups.values()) {
    if (group[0]) selected.push(group[0].chunk);
    if (selected.length >= limit) break;
  }

  const perBook = new Map(selected.map((chunk) => [chunk.bookId, 1]));
  for (const item of scored) {
    if (selected.includes(item.chunk)) continue;
    const count = perBook.get(item.chunk.bookId) || 0;
    if (count >= 3) continue;
    selected.push(item.chunk);
    perBook.set(item.chunk.bookId, count + 1);
    if (selected.length >= limit) break;
  }

  if (selected.length < Math.min(limit, knowledge.chunks.length)) {
    for (const item of scored) {
      if (!selected.includes(item.chunk)) selected.push(item.chunk);
      if (selected.length >= limit) break;
    }
  }

  return selected.map((chunk, index) => ({
    sourceId: `S${index + 1}`,
    title: chunk.title,
    author: chunk.author,
    page: chunk.page,
    text: chunk.text
  }));
}

function expandQueryTerms(query) {
  const base = tokenize(query);
  const expansions = [
    'negotiation',
    'bargaining',
    'persuasion',
    'influence',
    'interests',
    'options',
    'criteria',
    'batna',
    'zopa',
    'anchoring',
    'concession',
    'deadline',
    'pressure',
    'scarcity',
    'reciprocity',
    'commitment',
    'consistency',
    'authority',
    'social',
    'proof',
    'liking',
    'empathy',
    'labeling',
    'mirroring',
    'calibrated',
    'questions',
    'fairness',
    'objective',
    'criteria'
  ];

  const text = String(query);
  if (/价格|报价|预算|折扣|锚定/.test(text)) expansions.push('anchor', 'anchoring', 'price', 'offer');
  if (/时间|今天|马上|截止|最后|赶紧/.test(text)) expansions.push('deadline', 'time', 'pressure', 'urgency');
  if (/让步|先给|先做|先付|承诺/.test(text)) expansions.push('concession', 'commitment', 'reciprocity');
  if (/底线|选择|方案|替代/.test(text)) expansions.push('batna', 'options', 'alternatives');
  if (/情绪|威胁|生气|关系/.test(text)) expansions.push('empathy', 'labeling', 'feelings');

  return Array.from(new Set([...base, ...expansions].map((item) => item.toLowerCase())));
}

function formatSourcesForPrompt(retrieved) {
  if (!retrieved.length) return '未找到本地知识库摘录。';
  return retrieved
    .map((item) => `[${item.sourceId}] ${item.title}，${item.author}，第 ${item.page} 页：${clipForPrompt(item.text)}`)
    .join('\n\n');
}

function buildCitationCatalog(retrieved) {
  return retrieved.map((item) => ({
    id: item.sourceId,
    title: item.title,
    author: item.author,
    page: item.page,
    principle: inferPrinciple(item)
  }));
}

function normalizeCitations(items, available) {
  const byId = new Map(available.map((item) => [item.id, item]));
  const normalized = [];

  for (const item of arrayOr(items)) {
    const id = stringOr(item.id, '');
    const known = byId.get(id);
    if (!known) continue;
    normalized.push({
      ...known,
      principle: stringOr(item.principle, known.principle)
    });
  }

  if (!normalized.length) return available.slice(0, 4);
  return normalized.slice(0, 8);
}

function inferPrinciple(item) {
  const text = `${item.title} ${item.text}`.toLowerCase();
  if (item.title.includes('Getting to Yes')) return '区分立场和利益，并用客观标准来校准条件。';
  if (item.title.includes('Never Split the Difference')) return '先用战术同理心和校准式问题弄清对方真实约束。';
  if (item.title.includes('Negotiation Genius')) return '先准备底线、替代方案和价值创造空间，再进入条件交换。';
  if (item.title.includes('Power Negotiating')) return '识别报价、让步和时间压力中的谈判战术，避免仓促承诺。';
  if (item.title.includes('Influence')) return '警惕稀缺、承诺一致和互惠等影响力原则被用来推动你快速让步。';
  if (text.includes('batna')) return '先明确替代方案和底线，再判断是否需要接受当前条件。';
  if (text.includes('objective') || text.includes('criteria')) return '把谈判从立场转向客观标准，减少被情绪或单方说法带偏。';
  if (text.includes('anchor')) return '先出现的数字会影响判断，回应报价前要重新校准合理区间。';
  if (text.includes('reciprocity')) return '让步应当有对等交换，避免单方面先投入。';
  if (text.includes('scarcity')) return '稀缺和时间压力会放大冲动决策，需要先核对事实。';
  if (text.includes('label') || text.includes('empathy')) return '先标注和确认对方情绪或诉求，再推进条件讨论。';
  return '先澄清真实利益、选项和标准，再决定如何回应。';
}

function sourceIdsOr(value, fallback) {
  const ids = arrayOr(value).map((item) => String(item)).filter((item) => /^S\d+$/.test(item));
  return ids.length ? ids.slice(0, 4) : fallback;
}

function clipForPrompt(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 700);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function riskOr(value, fallback) {
  return ['低', '中', '高'].includes(value) ? value : fallback;
}

function arrayOr(value) {
  return Array.isArray(value) ? value : [];
}

function tokenize(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z][a-z'-]{2,}|[\u4e00-\u9fff]{2,}/g);
  return Array.from(new Set(words || []));
}
