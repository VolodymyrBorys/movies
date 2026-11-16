export interface QdrantDocumentInput {
  documentId: string;
  content: string;
  source: string;
  chunkIndex: number;
}

export type QdrantDocumentPayload = {
  documentId: string;
  content: string;
  source: string;
  chunkIndex: number;
  indexedAt: string;
};

export interface UpsertDocumentsResult {
  upsertedCount: number;
  pointIds: string[];
  batchSize: number;
}

export interface QdrantSearchOptions {
  limit?: number;
  scoreThreshold?: number;
  documentId?: string;
  source?: string;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload: QdrantDocumentPayload;
}
