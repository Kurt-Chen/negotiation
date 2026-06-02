export type Risk = '低' | '中' | '高';

export type Citation = {
  id: string;
  title: string;
  author: string;
  page: number;
  principle: string;
};

export type Trap = {
  name: string;
  risk: Risk;
  evidence: string;
  why: string;
  counter: string;
  sourceIds: string[];
};

export type ResponseDraft = {
  tone: string;
  text: string;
  sourceIds: string[];
};

export type ContextChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
  citations?: Citation[];
  createdAt: string;
};

export type ContextChatResult = {
  reply: string;
  updatedContext: string;
  citations: Citation[];
  source?: 'deepseek' | 'local';
};

export type Session = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  context: string;
  contextDraft: string;
  contextMessages: ContextChatMessage[];
  negotiationMessages: ChatMessage[];
  lastText: string;
  lastAnalysis: Analysis | null;
};

export type Analysis = {
  summary: string;
  overallRisk: Risk;
  traps: Trap[];
  responses: ResponseDraft[];
  nextQuestions: string[];
  boundaries: string[];
  citations: Citation[];
  source?: 'deepseek' | 'local';
};

export type ChatMessage =
  | { id: string; role: 'user'; text: string; imageUrl?: string; createdAt?: string }
  | { id: string; role: 'assistant'; analysis: Analysis; createdAt?: string };

export type ApiStatus = {
  configured: boolean;
  model: string;
  knowledge?: {
    ready: boolean;
    chunkCount: number;
    books: Array<{
      id: string;
      title: string;
      author: string;
      pages: number;
      chunks: number;
    }>;
  };
};
