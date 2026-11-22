import { getQdrantClient } from "../../../infrastructure/qdrant/qdrant.client.ts";

export const TECHNICAL_DOCUMENTS_COLLECTION = "technical_documents";

const VECTOR_SIZE = 768;
const DISTANCE = "Cosine" as const;

export class QdrantCollectionService {
  async ensureTechnicalDocumentsCollection(): Promise<void> {
    const { exists } = await getQdrantClient().collectionExists(
      TECHNICAL_DOCUMENTS_COLLECTION,
    );

    if (!exists) {
      await getQdrantClient().createCollection(TECHNICAL_DOCUMENTS_COLLECTION, {
        vectors: {
          size: VECTOR_SIZE,
          distance: DISTANCE,
        },
      });

      console.log(`Collection "${TECHNICAL_DOCUMENTS_COLLECTION}" created`);
    }

    const collection = await getQdrantClient().getCollection(
      TECHNICAL_DOCUMENTS_COLLECTION,
    );

    const vectors = collection.config.params.vectors ?? {};

    if (
      !("size" in vectors) ||
      vectors.size !== VECTOR_SIZE ||
      vectors.distance !== DISTANCE
    ) {
      throw new Error(
        `Collection "${TECHNICAL_DOCUMENTS_COLLECTION}" has incompatible vector configuration`,
      );
    }
  }
}

export const qdrantCollectionService = new QdrantCollectionService();
