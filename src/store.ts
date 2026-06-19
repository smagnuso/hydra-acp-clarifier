import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QuestionArraySchema, type Question } from "./question.js";
import { questionsFilePath } from "./paths.js";

export async function loadQuestions(sessionId: string): Promise<Question[]> {
  const path = questionsFilePath(sessionId);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    const result = QuestionArraySchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    console.warn(
      `[clarifier] loadQuestions: validation failed for ${path}: ${result.error.message}`,
    );
    return [];
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      return [];
    }
    console.warn(`[clarifier] loadQuestions: failed to read ${path}:`, err);
    return [];
  }
}

export async function saveQuestions(
  sessionId: string,
  questions: Question[],
): Promise<void> {
  const path = questionsFilePath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  const data = JSON.stringify(questions, null, 2);
  try {
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, path);
  } catch (err: unknown) {
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export async function deleteQuestions(
  sessionId: string,
): Promise<void> {
  const path = questionsFilePath(sessionId);
  try {
    await rm(path);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}
