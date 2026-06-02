import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clipboard,
  Copy,
  Download,
  History,
  ImagePlus,
  Library,
  Loader2,
  MessageSquareText,
  Paperclip,
  Plus,
  RefreshCcw,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X
} from 'lucide-react';
import { analyzeNegotiation, chatAboutContext, getApiStatus } from './api';
import { recognizeImageText } from './ocr';
import type { Analysis, ApiStatus, ChatMessage, Citation, ContextChatMessage, Risk, Session } from './types';

type Stage = 'idle' | 'ocr' | 'analyzing' | 'done' | 'error';
type ContextStage = 'idle' | 'ocr' | 'chatting';

const sampleText = '今天必须定下来，不然这个价格就没有了。你先付一部分表示诚意，后面的细节我们回头再慢慢对。';
const sessionStorageKey = 'negotiation-assistant.sessions.v1';

export function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const contextFileRef = useRef<HTMLInputElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [contextStage, setContextStage] = useState<ContextStage>('idle');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState('');
  const [contextDraft, setContextDraft] = useState('');
  const [contextInput, setContextInput] = useState('');
  const [attachment, setAttachment] = useState<{ file: File; url: string } | null>(null);
  const [contextAttachment, setContextAttachment] = useState<{ file: File; url: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contextMessages, setContextMessages] = useState<ContextChatMessage[]>([]);
  const [lastText, setLastText] = useState('');
  const [lastAnalysis, setLastAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ value: 0, label: '' });
  const [contextProgress, setContextProgress] = useState({ value: 0, label: '' });
  const [copied, setCopied] = useState('');
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [booksOpen, setBooksOpen] = useState(false);

  useEffect(() => {
    getApiStatus().then(setStatus).catch(() => setStatus({ configured: false, model: 'deepseek-v4-flash' }));

    const stored = loadStoredSessions();
    const initial = stored[0] || createBlankSession();
    setSessions(stored.length ? stored : [initial]);
    loadSession(initial);

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    setSessions((items) => {
      const now = new Date().toISOString();
      const next = items.map((item) =>
        item.id === activeSessionId
          ? {
              ...item,
              title: deriveSessionTitle(context, contextMessages, messages),
              updatedAt: now,
              context,
              contextDraft,
              contextMessages,
              negotiationMessages: messages,
              lastText,
              lastAnalysis
            }
          : item
      );
      saveStoredSessions(next);
      return next;
    });
  }, [activeSessionId, context, contextDraft, contextMessages, messages, lastText, lastAnalysis]);

  const activeRisk = useMemo(() => riskTone(lastAnalysis?.overallRisk || '低'), [lastAnalysis]);
  const isBusy = stage === 'ocr' || stage === 'analyzing';
  const isContextBusy = contextStage === 'ocr' || contextStage === 'chatting';
  const contextChanged = contextDraft.trim() !== context.trim();

  function loadSession(session: Session) {
    setActiveSessionId(session.id);
    setContext(session.context);
    setContextDraft(session.contextDraft || session.context);
    setContextMessages(session.contextMessages || []);
    setMessages(session.negotiationMessages || []);
    setLastText(session.lastText || '');
    setLastAnalysis(session.lastAnalysis || null);
    setDraft('');
    setContextInput('');
    setAttachment(null);
    setContextAttachment(null);
    setError('');
  }

  function newSession() {
    const session = createBlankSession();
    setSessions((items) => {
      const next = [session, ...items];
      saveStoredSessions(next);
      return next;
    });
    loadSession(session);
  }

  function deleteSession(id: string) {
    setSessions((items) => {
      const next = items.filter((item) => item.id !== id);
      const fallback = next[0] || createBlankSession();
      const finalItems = next.length ? next : [fallback];
      saveStoredSessions(finalItems);
      if (id === activeSessionId) loadSession(fallback);
      return finalItems;
    });
  }

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

  function pickContextAttachment(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('请发送背景截图图片，或直接输入背景。');
      return;
    }
    if (contextAttachment?.url) URL.revokeObjectURL(contextAttachment.url);
    setContextAttachment({ file, url: URL.createObjectURL(file) });
    setError('');
  }

  async function sendMessage(textOverride?: string, fileOverride?: File) {
    const textToSend = (textOverride ?? draft).trim();
    const fileToSend = fileOverride ?? attachment?.file;
    const imageUrl = fileToSend ? URL.createObjectURL(fileToSend) : attachment?.url;
    const contextForAnalysis = contextDraft.trim() || context;

    if (contextDraft.trim() && contextChanged) {
      setContext(contextDraft.trim());
    }

    if (!textToSend && !fileToSend) {
      setError('把截图粘贴到谈判内容框，或直接输入对方的话术。');
      setStage('error');
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: textToSend || '我发了一张谈判截图，请帮我识别陷阱并给回应参考。',
      imageUrl,
      createdAt: new Date().toISOString()
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
      const result = await analyzeNegotiation(textForAnalysis, contextForAnalysis);
      setLastAnalysis(result);
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: 'assistant', analysis: result, createdAt: new Date().toISOString() }]);
      setStage('done');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : '识别或分析失败，请换一张更清晰的截图。');
    }
  }

  async function sendContextMessage(textOverride?: string, fileOverride?: File) {
    const textToSend = (textOverride ?? contextInput).trim();
    const fileToSend = fileOverride ?? contextAttachment?.file;
    const imageUrl = fileToSend ? URL.createObjectURL(fileToSend) : contextAttachment?.url;

    if (!textToSend && !fileToSend) {
      setError('请输入背景条件，或上传一张背景截图。');
      return;
    }

    try {
      let textForContext = textToSend;
      if (fileToSend) {
        setContextStage('ocr');
        setContextProgress({ value: 0.03, label: '读取背景截图' });
        const recognized = await recognizeImageText(fileToSend, (value, label) => setContextProgress({ value, label }));
        textForContext = [textToSend, recognized].filter(Boolean).join('\n\n');
      }

      const userMessage: ContextChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: textForContext || '我发了一张背景截图，请帮我整理背景条件。',
        imageUrl,
        createdAt: new Date().toISOString()
      };
      const nextMessages = [...contextMessages, userMessage];
      setContextMessages(nextMessages);
      setContextInput('');
      setContextAttachment(null);
      setError('');
      setContextStage('chatting');

      const result = await chatAboutContext(nextMessages, contextDraft.trim() || context);
      const assistantMessage: ContextChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: result.reply,
        citations: result.citations,
        createdAt: new Date().toISOString()
      };
      setContextMessages((items) => [...items, assistantMessage]);
      setContext(result.updatedContext);
      setContextDraft(result.updatedContext);
      setContextStage('idle');
    } catch (err) {
      setContextStage('idle');
      setError(err instanceof Error ? err.message : '背景截图识别或背景对话失败。');
    }
  }

  async function rerun() {
    if (!lastText.trim()) {
      setError('还没有可重新分析的内容。');
      return;
    }
    const contextForAnalysis = contextDraft.trim() || context;
    if (contextDraft.trim() && contextChanged) {
      setContext(contextDraft.trim());
    }
    setStage('analyzing');
    setError('');
    try {
      const result = await analyzeNegotiation(lastText, contextForAnalysis);
      setLastAnalysis(result);
      setMessages((items) => [...items, { id: crypto.randomUUID(), role: 'assistant', analysis: result, createdAt: new Date().toISOString() }]);
      setStage('done');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : '重新分析失败。');
    }
  }

  function saveContext() {
    setContext(contextDraft.trim());
    setError('');
  }

  function clearContext() {
    setContext('');
    setContextDraft('');
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

  function exportSessions() {
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), sessions }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `negotiation-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importSessions(file: File) {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const imported = Array.isArray(payload) ? payload : payload.sessions;
      if (!Array.isArray(imported)) throw new Error('文件里没有会话列表。');
      const normalized = imported.map(normalizeSession).filter(Boolean) as Session[];
      if (!normalized.length) throw new Error('没有可导入的会话。');
      setSessions(normalized);
      saveStoredSessions(normalized);
      loadSession(normalized[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败，请确认是导出的会话 JSON。');
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
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
            <p>先和 AI 聊清背景，再把对方话术或截图发来分析；建议会附书籍来源。</p>
          </div>
        </div>
        <div className="top-actions">
          <span className={`api-pill ${status?.configured ? 'ready' : 'missing'}`}>
            <CheckCircle2 size={16} />
            {status?.configured ? `DeepSeek 已连接 · ${status.model}` : '未配置 DeepSeek · 本地规则'}
          </span>
          <div className="knowledge-menu">
            <button
              className={`api-pill knowledge-button ${status?.knowledge?.ready ? 'ready' : 'missing'}`}
              onClick={() => setBooksOpen((value) => !value)}
              type="button"
            >
              <BookOpen size={16} />
              {status?.knowledge?.ready ? `知识库 ${status.knowledge.books.length} 本 · ${status.knowledge.chunkCount} 段` : '知识库未生成'}
            </button>
            {booksOpen && (
              <div className="knowledge-popover">
                <div className="context-dialog-head">
                  <Library size={17} />
                  <h2>知识库书目</h2>
                </div>
                <div className="book-list">
                  {status?.knowledge?.books?.length ? (
                    status.knowledge.books.map((book) => (
                      <article className="book-item" key={book.id}>
                        <h3>{book.title}</h3>
                        <p>{book.author}</p>
                        <span>
                          {book.pages} 页 · {book.chunks} 段
                        </span>
                      </article>
                    ))
                  ) : (
                    <p className="context-empty">知识库还没有生成。</p>
                  )}
                </div>
              </div>
            )}
          </div>
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
              <p>{lastAnalysis?.summary || '谈判内容发出后，这里会同步显示整体判断和来源引用。'}</p>
            </div>
          </div>

          <section className="context-dialog" aria-label="背景条件对话框">
            <div className="context-dialog-head">
              <MessageSquareText size={17} />
              <h2>背景聊天</h2>
            </div>

            <div className="context-stream">
              {contextMessages.length === 0 ? (
                <p className="context-empty">先告诉我对方是谁、你的目标和底线；也可以上传背景截图。</p>
              ) : (
                contextMessages.map((message) => (
                  <article className={`context-chat-message ${message.role}`} key={message.id}>
                    {message.imageUrl && <img src={message.imageUrl} alt="背景截图" />}
                    <p>{message.text}</p>
                    {message.citations?.length ? <MiniCitations citations={message.citations} /> : null}
                  </article>
                ))
              )}
              {isContextBusy && (
                <div className="context-busy">
                  <Loader2 className="spin" size={16} />
                  <span>{contextStage === 'ocr' ? contextProgress.label || '正在识别背景截图' : '正在追问和整理背景'}</span>
                </div>
              )}
              {context && (
                <div className="context-message">
                  <span>已整理背景</span>
                  <p>{context}</p>
                </div>
              )}
            </div>

            {contextAttachment && (
              <div className="attachment-preview compact">
                <img src={contextAttachment.url} alt="待发送背景截图" />
                <span>{contextAttachment.file.name}</span>
                <button className="icon-button mini" onClick={() => setContextAttachment(null)} title="移除背景截图">
                  <X size={16} />
                </button>
              </div>
            )}

            <input
              ref={contextFileRef}
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) pickContextAttachment(file);
              }}
            />
            <textarea
              className="context-input"
              value={contextInput}
              onChange={(event) => setContextInput(event.target.value)}
              onPaste={(event) => {
                const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith('image/'));
                if (file) {
                  event.preventDefault();
                  pickContextAttachment(file);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendContextMessage();
              }}
              placeholder="继续补充背景，或问 AI：我还该交代什么？"
            />
            <div className="context-actions">
              <button className="icon-button" onClick={() => contextFileRef.current?.click()} title="添加背景截图">
                <Paperclip size={18} />
              </button>
              <button className="secondary-button" onClick={saveContext} disabled={!contextDraft.trim() || !contextChanged}>
                保存整理
              </button>
              <button className="icon-button mini" onClick={clearContext} disabled={!context && !contextDraft} title="清空整理背景">
                <X size={16} />
              </button>
              <button className="primary-button context-send" onClick={() => void sendContextMessage()} disabled={isContextBusy}>
                {isContextBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                <span>发送</span>
              </button>
            </div>
          </section>

          <section className="history-panel">
            <div className="history-head">
              <div className="context-dialog-head">
                <History size={17} />
                <h2>历史记录</h2>
              </div>
              <button className="icon-button mini" onClick={newSession} title="新会话">
                <Plus size={16} />
              </button>
            </div>
            <div className="history-actions">
              <button className="secondary-button" onClick={exportSessions}>
                <Download size={15} />
                导出同步
              </button>
              <input
                ref={importRef}
                type="file"
                accept="application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importSessions(file);
                }}
              />
              <button className="secondary-button" onClick={() => importRef.current?.click()}>
                <Upload size={15} />
                导入同步
              </button>
            </div>
            <div className="history-list">
              {sessions.map((session) => (
                <button className={`history-item ${session.id === activeSessionId ? 'active' : ''}`} key={session.id} onClick={() => loadSession(session)}>
                  <span>{session.title}</span>
                  <small>{formatTime(session.updatedAt)}</small>
                  <i
                    role="button"
                    tabIndex={0}
                    title="删除会话"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteSession(session.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') deleteSession(session.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </i>
                </button>
              ))}
            </div>
          </section>
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
                <span>{stage === 'ocr' ? progress.label || '正在识别截图文字' : '正在生成提示、回应和引用来源'}</span>
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
              <button className="icon-button" onClick={() => inputRef.current?.click()} title="添加谈判截图">
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
                placeholder="粘贴截图或输入对方话术。"
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
      <h2>发送谈判内容</h2>
      <p>右侧分析对方话术；左侧先和 AI 聊清背景。支持两个区域分别粘贴截图。</p>
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
  const citationMap = new Map(analysis.citations.map((item) => [item.id, item]));

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
            <SourceRefs ids={trap.sourceIds} citationMap={citationMap} />
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
              <SourceRefs ids={draft.sourceIds} citationMap={citationMap} />
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

      <div className="sources-panel">
        <div className="section-heading">
          <BookOpen size={18} />
          <h2>引用来源</h2>
        </div>
        {analysis.citations.length ? (
          <div className="source-list">
            {analysis.citations.map((source) => (
              <article className="source-item" key={source.id}>
                <span>{source.id}</span>
                <div>
                  <h3>
                    {source.title} · 第 {source.page} 页
                  </h3>
                  <p>{source.author}</p>
                  <p>{source.principle}</p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-source">还没有可用来源。请先生成本地知识库索引。</p>
        )}
      </div>
    </div>
  );
}

function SourceRefs({ ids, citationMap }: { ids: string[]; citationMap: Map<string, Citation> }) {
  const labels = ids.map((id) => citationMap.get(id)).filter((item): item is Citation => Boolean(item));
  if (!labels.length) return null;
  return (
    <div className="source-refs" title={labels.map((item) => `${item.id}: ${item.title} 第 ${item.page} 页`).join('\n')}>
      <BookOpen size={14} />
      <span>{labels.map((item) => `${item.id} ${item.title} p.${item.page}`).join(' · ')}</span>
    </div>
  );
}

function MiniCitations({ citations }: { citations: Citation[] }) {
  return (
    <div className="mini-citations">
      {citations.slice(0, 3).map((citation) => (
        <span key={citation.id}>
          {citation.title} p.{citation.page}
        </span>
      ))}
    </div>
  );
}

function riskTone(risk: Risk | '待识别') {
  if (risk === '高') return 'danger';
  if (risk === '中') return 'warning';
  return 'safe';
}

function createBlankSession(): Session {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: '新的谈判',
    createdAt: now,
    updatedAt: now,
    context: '',
    contextDraft: '',
    contextMessages: [],
    negotiationMessages: [],
    lastText: '',
    lastAnalysis: null
  };
}

function loadStoredSessions(): Session[] {
  try {
    const raw = localStorage.getItem(sessionStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSession).filter(Boolean) as Session[];
  } catch {
    return [];
  }
}

function saveStoredSessions(sessions: Session[]) {
  localStorage.setItem(sessionStorageKey, JSON.stringify(sessions.slice(0, 50)));
}

function normalizeSession(value: unknown): Session | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<Session>;
  const now = new Date().toISOString();
  return {
    id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
    title: typeof item.title === 'string' ? item.title : '导入的谈判',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
    context: typeof item.context === 'string' ? item.context : '',
    contextDraft: typeof item.contextDraft === 'string' ? item.contextDraft : typeof item.context === 'string' ? item.context : '',
    contextMessages: Array.isArray(item.contextMessages) ? item.contextMessages : [],
    negotiationMessages: Array.isArray(item.negotiationMessages) ? item.negotiationMessages : [],
    lastText: typeof item.lastText === 'string' ? item.lastText : '',
    lastAnalysis: item.lastAnalysis || null
  };
}

function deriveSessionTitle(context: string, contextMessages: ContextChatMessage[], messages: ChatMessage[]) {
  const firstNegotiation = messages.find((message) => message.role === 'user') as Extract<ChatMessage, { role: 'user' }> | undefined;
  const firstContext = contextMessages.find((message) => message.role === 'user');
  const raw = firstNegotiation?.text || firstContext?.text || context || '新的谈判';
  return raw.replace(/\s+/g, ' ').slice(0, 22);
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
