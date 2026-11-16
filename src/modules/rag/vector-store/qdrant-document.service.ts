import { randomUUID } from "node:crypto";
import { embeddingService } from "../embedding/embedding.service.ts";
import { qdrantClient } from "../../../infrastructure/qdrant/qdrant.client.ts";
import type { Schemas } from "@qdrant/js-client-rest";
import type {
  QdrantDocumentPayload,
  UpsertDocumentsResult,
} from "./qdrant.types.ts";

const COLLECTION_NAME = "technical_documents";
const VECTOR_SIZE = 768;
const BATCH_SIZE = 32;

export interface QdrantDocumentInput {
  documentId: string;
  content: string;
  source: string;
  chunkIndex: number;
}

export class QdrantDocumentService {
  async upsertDocument(document: QdrantDocumentInput): Promise<void> {
    await this.upsertDocuments([document]);
  }

  async upsertDocuments(
    documents: QdrantDocumentInput[],
  ): Promise<UpsertDocumentsResult> {
    if (documents.length === 0) {
      return {
        batchSize: BATCH_SIZE,
        pointIds: [],
        upsertedCount: 0,
      };
    }

    this.validateDocuments(documents);

    const pointIds: string[] = [];
    let inserted = 0;

    for (let offset = 0; offset < documents.length; offset += BATCH_SIZE) {
      const batch = documents.slice(offset, offset + BATCH_SIZE);

      const points: Schemas["PointStruct"][] = await Promise.all(
        batch.map(async (document): Promise<Schemas["PointStruct"]> => {
          const vector = await embeddingService.embedDocument(document.content);

          this.validateVector(vector);

          const payload: QdrantDocumentPayload = {
            documentId: document.documentId,
            content: document.content,
            source: document.source,
            chunkIndex: document.chunkIndex,
            indexedAt: new Date().toISOString(),
          };

          return {
            id: randomUUID(),
            vector,
            payload,
          };
        }),
      );

      await qdrantClient.upsert(COLLECTION_NAME, {
        wait: true,
        points,
      });

      await qdrantClient.upsert(COLLECTION_NAME, {
        wait: true,
        points,
      });

      pointIds.push(...points.map((point) => String(point.id)));
      inserted += points.length;
    }

    return {
      upsertedCount: inserted,
      pointIds,
      batchSize: BATCH_SIZE,
    };
  }

  private validateDocuments(documents: QdrantDocumentInput[]): void {
    for (const [index, document] of documents.entries()) {
      if (!document.documentId.trim()) {
        throw new Error(`Document at index ${index} has an empty documentId`);
      }

      if (!document.content.trim()) {
        throw new Error(`Document at index ${index} has empty content`);
      }

      if (!document.source.trim()) {
        throw new Error(`Document at index ${index} has an empty source`);
      }

      if (!Number.isInteger(document.chunkIndex) || document.chunkIndex < 0) {
        throw new Error(`Document at index ${index} has an invalid chunkIndex`);
      }
    }
  }

  private validateVector(vector: number[]): void {
    if (vector.length !== VECTOR_SIZE) {
      throw new Error(
        `Invalid embedding dimensions: expected ${VECTOR_SIZE}, received ${vector.length}`,
      );
    }

    if (!vector.every(Number.isFinite)) {
      throw new Error("Embedding contains invalid numeric values");
    }
  }
}

export const qdrantDocumentService = new QdrantDocumentService();
