import type { Analysis, ApiStatus, ContextChatMessage, ContextChatResult } from './types';

export async function getApiStatus(): Promise<ApiStatus> {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error('无法读取服务状态');
  return response.json();
}

export async function analyzeNegotiation(text: string, context: string): Promise<Analysis> {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, context })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || '分析失败');
  return data;
}

export async function chatAboutContext(messages: ContextChatMessage[], currentContext: string): Promise<ContextChatResult> {
  const response = await fetch('/api/context-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentContext,
      messages: messages.map((message) => ({
        role: message.role,
        text: message.text
      }))
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || '背景对话失败');
  return data;
}
