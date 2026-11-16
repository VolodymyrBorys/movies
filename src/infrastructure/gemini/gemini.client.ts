import { GoogleGenAI } from "@google/genai";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = join(import.meta.dirname, "../../../.env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is missing");
}

export const geminiClient = new GoogleGenAI({
  apiKey,
});
