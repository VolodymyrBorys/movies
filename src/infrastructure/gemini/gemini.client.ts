import { GoogleGenAI } from "@google/genai";
import { ragConfig, RagNotConfiguredError } from "../../config/rag.ts";

let client: GoogleGenAI | undefined;

/**
 * Created on first use, so importing this module never fails: the API starts
 * without RAG config, and RAG calls fail with RagNotConfiguredError instead.
 */
export function getGeminiClient(): GoogleGenAI {
  if (client) return client;
  if (!ragConfig) throw new RagNotConfiguredError();

  client = new GoogleGenAI({ apiKey: ragConfig.gemini.apiKey });
  return client;
}
