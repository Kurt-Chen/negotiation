import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const port = Number(process.env.PORT || 5173);

loadDotEnv(resolve(root, '.env'));

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/status', (_req, res) => {
  res.json({
    configured: hasDeepSeekKey(),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
  });
});

app.post('/api/analyze', async (req, res) => {
  const { text, context } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim().length < 4) {
    return res.status(400).json({ error: '截图文字太少，请重新上传更清晰的截图，或手动补充谈判内容。' });
  }

  if (!hasDeepSeekKey()) {
    return res.json(buildLocalAnalysis(text));
  }

  try {
    const result = await analyzeWithDeepSeek(text, context);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: 'DeepSeek 分析暂时失败，已保留聊天内容，你可以稍后重试。',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

if (!isProduction) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root,
    server: { middlewareMode: true },
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
});

async function analyzeWithDeepSeek(text, context = '') {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      temperature: 0.35,
      thinking: { type: process.env.DEEPSEEK_THINKING || 'disabled' },
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '你是一个中文谈判教练。用户会把谈判截图或对方话术发到聊天框，你要识别话术陷阱、信息不对称、压力测试、锚定、稀缺性、模糊承诺、单方让步、假二选一、时间压力和情绪勒索，并给出可直接参考的回复。只输出 JSON，不要 Markdown。'
        },
        {
          role: 'user',
          content: `请分析以下用户发到聊天框的谈判内容，并输出 JSON。\n\n上下文：${context || '无'}\n\n聊天内容：\n${text}\n\nJSON 字段必须为：\n{\n  "summary": "一句话概括局面",\n  "overallRisk": "低|中|高",\n  "traps": [{"name":"陷阱名称","risk":"低|中|高","evidence":"引用或概括对方话术","why":"为什么危险","counter":"提示用户该怎么判断和接话"}],\n  "responses": [{"tone":"稳健|强硬|缓和","text":"可直接复制或参考的中文回应"}],\n  "nextQuestions": ["继续谈判前该问清的问题"],\n  "boundaries": ["要守住的底线"]\n}`
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
  return normalizeAnalysis(JSON.parse(content), text);
}

function hasDeepSeekKey() {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  return Boolean(key && key !== 'your_deepseek_api_key_here' && key.startsWith('sk-'));
}

function normalizeAnalysis(payload, sourceText) {
  return {
    summary: stringOr(payload.summary, '已识别截图内容，请结合原文确认关键信息。'),
    overallRisk: riskOr(payload.overallRisk, '中'),
    traps: arrayOr(payload.traps).slice(0, 6).map((item) => ({
      name: stringOr(item.name, '潜在话术陷阱'),
      risk: riskOr(item.risk, '中'),
      evidence: stringOr(item.evidence, sourceText.slice(0, 80)),
      why: stringOr(item.why, '这可能让你在信息不足时做出承诺。'),
      counter: stringOr(item.counter, '先确认事实、条件和退出机制，再回应对方。')
    })),
    responses: arrayOr(payload.responses).slice(0, 4).map((item) => ({
      tone: stringOr(item.tone, '稳健'),
      text: stringOr(item.text, '我需要先确认关键条件，再决定下一步。')
    })),
    nextQuestions: arrayOr(payload.nextQuestions).slice(0, 6).map((item) => String(item)),
    boundaries: arrayOr(payload.boundaries).slice(0, 6).map((item) => String(item)),
    source: 'deepseek'
  };
}

function buildLocalAnalysis(text) {
  const compact = text.replace(/\s+/g, ' ').trim();
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
      counter: '先把条件、期限、交付标准和对等交换写清楚，再决定是否推进。'
    }));

  if (traps.length === 0) {
    traps.push({
      name: '信息不足',
      risk: '中',
      evidence: compact.slice(0, 120),
      why: '当前文字没有足够上下文，容易误判对方真实诉求。',
      counter: '先追问目标、期限、可接受条件和不可变约束。'
    });
  }

  return {
    summary: '当前为本地规则分析：建议配置 DeepSeek API Key 获取更细判断。',
    overallRisk: traps.some((item) => item.risk === '高') ? '高' : '中',
    traps,
    responses: [
      {
        tone: '稳健',
        text: '我可以继续推进，但需要先把关键条件确认清楚：范围、时间、交付标准、费用/回报，以及如果条件变化怎么处理。'
      },
      {
        tone: '强硬',
        text: '在条件没有写清楚前，我不能先做单方承诺。我们可以把双方各自要承担的部分列出来，再谈下一步。'
      },
      {
        tone: '缓和',
        text: '我理解你想快点定下来。为了避免后面反复，我们先把几个关键点对齐，我再给你明确答复。'
      }
    ],
    nextQuestions: ['对方要求你先承诺什么？', '对方给出的交换条件是什么？', '是否有明确期限、标准和退出方式？'],
    boundaries: ['不在信息不足时承诺', '不接受只有你单方投入的安排', '所有关键条件落到文字'],
    source: 'local'
  };
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
