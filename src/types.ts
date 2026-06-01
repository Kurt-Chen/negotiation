export type Risk = '低' | '中' | '高';

export type Trap = {
  name: string;
  risk: Risk;
  evidence: string;
  why: string;
  counter: string;
};

export type ResponseDraft = {
  tone: string;
  text: string;
};

export type Analysis = {
  summary: string;
  overallRisk: Risk;
  traps: Trap[];
  responses: ResponseDraft[];
  nextQuestions: string[];
  boundaries: string[];
  source?: 'deepseek' | 'local';
};

export type ApiStatus = {
  configured: boolean;
  model: string;
};
