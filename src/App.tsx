import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Copy,
  ImagePlus,
  Loader2,
  Paperclip,
  RefreshCcw,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Wand2,
  X
} from 'lucide-react';
import { analyzeNegotiation, getApiStatus } from './api';
import { recognizeImageText } from './ocr';
import type { Analysis, ApiStatus, Risk } from './types';

type Stage = 'idle' | 'ocr' | 'analyzing' | 'done' | 'error';

type ChatMessage =
  | { id: string; role: 'user'; text: string; imageUrl?: string }
  | { id: string; role: 'assistant'; analysis: Analysis };

const sampleText =
  '今天必须定下来，不然这个价格就没有了。你先付一部分表示诚意，后面的细节我们回头再慢慢对。';

export function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState('');
  const [attachment, setAttachment] = useState<{ file: File; url: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastText, setLastText] = useState('');
  const [lastAnalysis, setLastAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ value: 0, label: '' });
  const [copied, setCopied] = useState('');
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);

  useEffect(() => {
    getApiStatus().then(setStatus).catch(() => setStatus({ configured: false, model: 'deepseek-v4-flash' }));

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  const activeRisk = useMemo(() => riskTone(lastAnalysis?.overallRisk || '低'), [lastAnalysis]);
  const isBusy = stage === 'ocr' || stage === 'analyzing';

  function pickAttachment(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('请发送截图图片，或直接粘贴文字。');
      return;
    }
    if (attachment?.url) URL.revokeObjectURL(attachment.url);
    setAttachment({ file, url: URL.createObjectURL(file) });
    setError('');
    textareaRef.current?.focus();
  }

  async function sendMessage(textOverride?: string, fileOverride?: File) {
    const textToSend = (textOverride ?? draft).trim();
    const fileToSend = fileOverride ?? attachment?.file;
    const imageUrl = fileToSend ? URL.createObjectURL(fileToSend) : attachment?.url;

    if (!textToSend && !fileToSend) {
      setError('把截图粘贴到聊天框，或直接输入对方的话术。');
      setStage('error');
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: textToSend || '我发了一张谈判截图，请帮我识别陷阱并给回应参考。',
      imageUrl
    };

    setMessages((items) => [...items, userMessage]);
    setDraft('');
    setAttachment(null);
    setError('');

    try {
      let textForAnalysis = textToSend;
      if (fileToSend) {
        setStage('ocr');
        setProgress({ value: 0.03, label: '读取聊天截图' });
        const recognized = await recognizeImageText(fileToSend, (value, label) => setProgress({ value, label }));
        textForAnalysis = [textToSend, recognized].filter(Boolean).join('\n\n');
      }

      setLastText(textForAnalysis);
      setStage('analyzing');
      const result = await analyzeNegotiation(textForAnalysis, context);
      setLastAnalysis(result);
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: 'assistant', analysis: result }]);
      setStage('done');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : '识别或分析失败，请换一张更清晰的截图。');
    }
  }

  async function rerun() {
    if (!lastText.trim()) {
      setError('还没有可重新分析的内容。');
      return;
    }
    setStage('analyzing');
    setError('');
    try {
      const result = await analyzeNegotiation(lastText, context);
      setLastAnalysis(result);
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: 'assistant', analysis: result }]);
      setStage('done');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : '重新分析失败。');
    }
  }

  async function copyText(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    window.setTimeout(() => setCopied(''), 1400);
  }

  async function triggerInstall() {
    const prompt = installPrompt as Event & { prompt?: () => Promise<void> };
    if (prompt?.prompt) await prompt.prompt();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <ShieldCheck size={23} />
          </span>
          <div>
            <h1>谈判防坑助手</h1>
            <p>把截图发到聊天框，我给你提示和回应参考。</p>
          </div>
        </div>
        <div className="top-actions">
          <span className={`api-pill ${status?.configured ? 'ready' : 'missing'}`}>
            <CheckCircle2 size={16} />
            {status?.configured ? `DeepSeek 已连接 · ${status.model}` : '未配置 DeepSeek · 本地演示'}
          </span>
          <button className="icon-button text-button" onClick={triggerInstall} disabled={!installPrompt} title="安装到手机">
            <Smartphone size={18} />
            <span>安装</span>
          </button>
        </div>
      </header>

      <section className="chat-layout">
        <aside className="side-panel">
          <div className="status-card">
            <span className={`risk-meter ${activeRisk}`}>{lastAnalysis?.overallRisk || '待识别'}</span>
            <div>
              <h2>当前风险</h2>
              <p>{lastAnalysis?.summary || '截图发出后，这里会同步显示整体判断。'}</p>
            </div>
          </div>

          <label className="field">
            <span>谈判背景</span>
            <textarea
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder="例如：对方是客户/供应商/老板；你的目标、底线和已知条件。"
            />
          </label>

          <div className="hint-list">
            <h3>我会重点看</h3>
            <p>时间压力、假二选一、模糊承诺、单方让步、锚定价格、情绪施压。</p>
          </div>

          <button className="secondary-button full" onClick={() => void rerun()} disabled={!lastText || isBusy}>
            <RefreshCcw size={17} />
            重新生成参考
          </button>
        </aside>

        <section
          className="chat-panel"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files?.[0];
            if (file) pickAttachment(file);
          }}
        >
          <div className="chat-stream">
            {messages.length === 0 && <EmptyChat onSample={() => void sendMessage(sampleText)} />}

            {messages.map((message) =>
              message.role === 'user' ? (
                <article className="message user-message" key={message.id}>
                  {message.imageUrl && <img className="message-image" src={message.imageUrl} alt="发送的谈判截图" />}
                  <p>{message.text}</p>
                </article>
              ) : (
                <article className="message assistant-message" key={message.id}>
                  <AnalysisCard analysis={message.analysis} copied={copied} copyText={copyText} />
                </article>
              )
            )}

            {isBusy && (
              <article className="message assistant-message busy-message">
                <Loader2 className="spin" size={18} />
                <span>{stage === 'ocr' ? progress.label || '正在识别截图文字' : '正在生成提示与回应参考'}</span>
                {stage === 'ocr' && (
                  <div className="progress-track">
                    <i style={{ width: `${Math.max(8, Math.round(progress.value * 100))}%` }} />
                  </div>
                )}
              </article>
            )}

            {error && (
              <div className="error-strip">
                <AlertTriangle size={18} />
                {error}
              </div>
            )}
          </div>

          <div className="composer">
            {attachment && (
              <div className="attachment-preview">
                <img src={attachment.url} alt="待发送截图" />
                <span>{attachment.file.name}</span>
                <button className="icon-button mini" onClick={() => setAttachment(null)} title="移除截图">
                  <X size={16} />
                </button>
              </div>
            )}

            <div className="composer-row">
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) pickAttachment(file);
                }}
              />
              <button className="icon-button" onClick={() => inputRef.current?.click()} title="添加截图">
                <Paperclip size={19} />
              </button>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith('image/'));
                  if (file) {
                    event.preventDefault();
                    pickAttachment(file);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage();
                }}
                placeholder="粘贴截图到这里，或补一句背景：例如“这是客户压价，我不想先让步”。"
              />
              <button className="primary-button send-button" onClick={() => void sendMessage()} disabled={isBusy}>
                {isBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                <span>发送</span>
              </button>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function EmptyChat({ onSample }: { onSample: () => void }) {
  return (
    <div className="empty-chat">
      <ImagePlus size={42} />
      <h2>把截图发到聊天框</h2>
      <p>支持粘贴截图、拖入截图、点附件选择截图；也可以直接粘贴对方的话。</p>
      <button className="secondary-button" onClick={onSample}>
        <Clipboard size={17} />
        试一段示例话术
      </button>
    </div>
  );
}

function AnalysisCard({
  analysis,
  copied,
  copyText
}: {
  analysis: Analysis;
  copied: string;
  copyText: (text: string, id: string) => Promise<void>;
}) {
  return (
    <div className="analysis-card">
      <div className="assistant-title">
        <Sparkles size={18} />
        <div>
          <h2>提示</h2>
          <p>{analysis.summary}</p>
        </div>
        <span className={`risk-meter compact ${riskTone(analysis.overallRisk)}`}>{analysis.overallRisk}</span>
      </div>

      <div className="trap-grid">
        {analysis.traps.map((trap, index) => (
          <article className="trap-row" key={`${trap.name}-${index}`}>
            <div className="trap-row-head">
              <span className={`risk-dot ${riskTone(trap.risk)}`}>{trap.risk}</span>
              <h3>{trap.name}</h3>
            </div>
            <p className="evidence">“{trap.evidence}”</p>
            <p>{trap.why}</p>
            <div className="counter">
              <strong>怎么接</strong>
              <span>{trap.counter}</span>
            </div>
          </article>
        ))}
      </div>

      <div className="response-section">
        <div className="section-heading">
          <Wand2 size={18} />
          <h2>回应参考</h2>
        </div>
        <div className="draft-stack">
          {analysis.responses.map((draft, index) => (
            <article className="draft" key={`${draft.tone}-${index}`}>
              <div className="draft-head">
                <span>{draft.tone}</span>
                <button className="icon-button mini" onClick={() => void copyText(draft.text, `draft-${index}`)} title="复制回应">
                  {copied === `draft-${index}` ? <CheckCircle2 size={17} /> : <Copy size={17} />}
                </button>
              </div>
              <p>{draft.text}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="reference-lists">
        <div className="checklist">
          <h3>继续前问清</h3>
          {analysis.nextQuestions.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
        <div className="checklist boundaries">
          <h3>守住底线</h3>
          {analysis.boundaries.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function riskTone(risk: Risk | '待识别') {
  if (risk === '高') return 'danger';
  if (risk === '中') return 'warning';
  return 'safe';
}
