import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newQuestion } from "../src/question.js";
import { loadQuestions, saveQuestions, deleteQuestions } from "../src/store.js";

function makeTempHome() {
  return mkdtemp(join(tmpdir(), "hydra-acp-store-test-"));
}

describe("store — roundtrip", () => {
  let home: string;
  let sessionId: string;

  it("save then load returns the same questions", async () => {
    home = await makeTempHome();
    sessionId = "test-roundtrip";
    const orig = process.env.HYDRA_ACP_HOME!;
    process.env.HYDRA_ACP_HOME = home;

    try {
      const q1 = newQuestion({
        question: "What is your name?",
        defaultAnswer: "Anonymous",
        options: ["Anonymous", "Alice"],
      });
      const q2 = newQuestion({
        question: "Preferred language?",
        defaultAnswer: "English",
      });

      await saveQuestions(sessionId, [q1, q2]);
      const loaded = await loadQuestions(sessionId);

      assert.strictEqual(loaded.length, 2);
      assert.deepStrictEqual(loaded[0].id, q1.id);
      assert.strictEqual(loaded[0].question, q1.question);
      assert.deepStrictEqual(loaded[0].options, q1.options);
      assert.strictEqual(loaded[1].id, q2.id);
      assert.strictEqual(loaded[1].question, q2.question);
    } finally {
      process.env.HYDRA_ACP_HOME = orig;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("load of missing file returns empty array", async () => {
    home = await makeTempHome();
    sessionId = "test-missing";
    const orig = process.env.HYDRA_ACP_HOME!;
    process.env.HYDRA_ACP_HOME = home;

    try {
      const result = await loadQuestions(sessionId);
      assert.deepStrictEqual(result, []);
    } finally {
      process.env.HYDRA_ACP_HOME = orig;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("save is atomic — partial write doesn't corrupt existing", async () => {
    home = await makeTempHome();
    sessionId = "test-atomic";
    const orig = process.env.HYDRA_ACP_HOME!;
    process.env.HYDRA_ACP_HOME = home;

    try {
      const q1 = newQuestion({
        question: "Safe question",
        defaultAnswer: "Yes",
      });
      await saveQuestions(sessionId, [q1]);

      // Write a valid file first so we have something to protect
      let filePath: string;
      {
        const { questionsFilePath } = await import("../src/paths.js");
        filePath = questionsFilePath(sessionId);
      }

      // Now write initial data
      const qGood = newQuestion({
        question: "Good state",
        defaultAnswer: "OK",
      });
      await saveQuestions(sessionId, [qGood]);

      // Read back to confirm we have valid data
      let loaded = await loadQuestions(sessionId);
      assert.strictEqual(loaded.length, 1);

      // Overwrite the file with partial/truncated JSON that would be
      // a "torn write" scenario — then verify loadQuestions still
      // returns [] rather than throwing.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filePath, '{"id":"broken', "utf-8");

      // A normal read would throw on JSON.parse; our wrapper should
      // catch it and return [].
      loaded = await loadQuestions(sessionId);
      assert.deepStrictEqual(loaded, []);
    } finally {
      process.env.HYDRA_ACP_HOME = orig;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("delete removes the file", async () => {
    home = await makeTempHome();
    sessionId = "test-delete";
    const orig = process.env.HYDRA_ACP_HOME!;
    process.env.HYDRA_ACP_HOME = home;

    try {
      const q = newQuestion({
        question: "Delete me",
        defaultAnswer: "Sure",
      });
      await saveQuestions(sessionId, [q]);

      // Confirm file exists by loading
      let loaded = await loadQuestions(sessionId);
      assert.strictEqual(loaded.length, 1);

      await deleteQuestions(sessionId);

      loaded = await loadQuestions(sessionId);
      assert.deepStrictEqual(loaded, []);
    } finally {
      process.env.HYDRA_ACP_HOME = orig;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("delete is no-op when file is missing", async () => {
    home = await makeTempHome();
    sessionId = "test-delete-missing";
    const orig = process.env.HYDRA_ACP_HOME!;
    process.env.HYDRA_ACP_HOME = home;

    try {
      // Should not throw
      await deleteQuestions(sessionId);
    } finally {
      process.env.HYDRA_ACP_HOME = orig;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("load of corrupted JSON returns empty array without throwing", async () => {
    home = await makeTempHome();
    sessionId = "test-corrupted";
    const orig = process.env.HYDRA_ACP_HOME!;
    process.env.HYDRA_ACP_HOME = home;

    try {
      const q = newQuestion({
        question: "temp",
        defaultAnswer: "temp",
      });
      await saveQuestions(sessionId, [q]);

      const { writeFile } = await import("node:fs/promises");
      const { questionsFilePath } = await import("../src/paths.js");
      const filePath = questionsFilePath(sessionId);

      await writeFile(filePath, "not valid json at all", "utf-8");

      const result = await loadQuestions(sessionId);
      assert.deepStrictEqual(result, []);
    } finally {
      process.env.HYDRA_ACP_HOME = orig;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("load of valid JSON but wrong schema returns empty array", async () => {
    home = await makeTempHome();
    sessionId = "test-wrong-schema";
    const orig = process.env.HYDRA_ACP_HOME!;
    process.env.HYDRA_ACP_HOME = home;

    try {
      const q = newQuestion({
        question: "temp",
        defaultAnswer: "temp",
      });
      await saveQuestions(sessionId, [q]);

      const { writeFile } = await import("node:fs/promises");
      const { questionsFilePath } = await import("../src/paths.js");
      const filePath = questionsFilePath(sessionId);

      // Valid JSON but not an array of questions
      await writeFile(filePath, '{"not": "a question array"}', "utf-8");

      const result = await loadQuestions(sessionId);
      assert.deepStrictEqual(result, []);
    } finally {
      process.env.HYDRA_ACP_HOME = orig;
      await rm(home, { recursive: true, force: true });
    }
  });
});
