export interface GenerateAnswerInput {
  question: string;
  context: string;
  signal?: AbortSignal;
}

export interface GenerateAnswerResult {
  answer: string;
  model: string;
}
