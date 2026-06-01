import type { Analysis, ApiStatus } from './types';

export async function getApiStatus(): Promise<ApiStatus> {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error('无法读取 DeepSeek 状态');
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
