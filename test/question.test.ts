import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { QuestionSchema, QuestionArraySchema, newQuestion } from "../src/question.js";

describe("QuestionSchema", () => {
  it("parses a valid record", () => {
    const input = {
      id: "test-id-1",
      question: "What is your preferred language?",
      defaultAnswer: "English",
      options: ["English", "Spanish", "French"],
      askedAt: 1700000000000,
      askedDuringTurn: "turn-abc",
      status: "open" as const,
    };
    const result = QuestionSchema.parse(input);
    assert.deepStrictEqual(result, input);
  });

  it("parses a minimal record without optional fields", () => {
    const input = {
      id: "test-id-2",
      question: "Are you ready?",
      defaultAnswer: "Yes",
      askedAt: 1700000000000,
      status: "closed" as const,
    };
    const result = QuestionSchema.parse(input);
    assert.deepStrictEqual(result, input);
  });

  it("rejects a record missing required field 'question'", () => {
    const input = {
      id: "test-id-3",
      defaultAnswer: "Yes",
      askedAt: 1700000000000,
      status: "open" as const,
    };
    assert.throws(() => QuestionSchema.parse(input), z.ZodError);
  });

  it("rejects a record missing required field 'defaultAnswer'", () => {
    const input = {
      id: "test-id-4",
      question: "Are you ready?",
      askedAt: 1700000000000,
      status: "open" as const,
    };
    assert.throws(() => QuestionSchema.parse(input), z.ZodError);
  });

  it("rejects a record missing required field 'status'", () => {
    const input = {
      id: "test-id-5",
      question: "Are you ready?",
      defaultAnswer: "Yes",
      askedAt: 1700000000000,
    };
    assert.throws(() => QuestionSchema.parse(input), z.ZodError);
  });

  it("rejects a record with an invalid status enum value", () => {
    const input = {
      id: "test-id-6",
      question: "Are you ready?",
      defaultAnswer: "Yes",
      askedAt: 1700000000000,
      status: "unknown" as unknown as "open",
    };
    assert.throws(() => QuestionSchema.parse(input), z.ZodError);
  });

  it("rejects a record where options is not an array of strings", () => {
    const input = {
      id: "test-id-7",
      question: "Are you ready?",
      defaultAnswer: "Yes",
      askedAt: 1700000000000,
      status: "open" as const,
      options: ["English", 42] as unknown as string[],
    };
    assert.throws(() => QuestionSchema.parse(input), z.ZodError);
  });
});

describe("QuestionArraySchema", () => {
  it("parses a valid array of questions", () => {
    const input = [
      {
        id: "a",
        question: "Q1?",
        defaultAnswer: "A",
        askedAt: 1,
        status: "open" as const,
      },
      {
        id: "b",
        question: "Q2?",
        defaultAnswer: "B",
        askedAt: 2,
        status: "closed" as const,
      },
    ];
    const result = QuestionArraySchema.parse(input);
    assert.deepStrictEqual(result, input);
  });

  it("rejects an array containing an invalid question", () => {
    const input = [
      {
        id: "a",
        question: "Q1?",
        defaultAnswer: "A",
        askedAt: 1,
        status: "open" as const,
      },
      {
        id: "b",
        // missing required fields
      },
    ];
    assert.throws(() => QuestionArraySchema.parse(input), z.ZodError);
  });
});

describe("newQuestion", () => {
  it("produces a record that passes the schema", () => {
    const q = newQuestion({
      question: "What is your name?",
      defaultAnswer: "Anonymous",
      options: ["Anonymous", "Alice", "Bob"],
    });
    const result = QuestionSchema.safeParse(q);
    assert.ok(result.success);
  });

  it("sets status to open", () => {
    const q = newQuestion({
      question: "Are you ready?",
      defaultAnswer: "Yes",
    });
    assert.strictEqual(q.status, "open");
  });

  it("sets askedAt to current epoch ms", () => {
    const before = Date.now();
    const q = newQuestion({
      question: "When was this created?",
      defaultAnswer: "Now",
    });
    const after = Date.now();
    assert.ok(q.askedAt >= before && q.askedAt <= after);
  });

  it("generates unique ids on repeated calls", () => {
    const q1 = newQuestion({
      question: "First?",
      defaultAnswer: "A",
    });
    const q2 = newQuestion({
      question: "Second?",
      defaultAnswer: "B",
    });
    assert.notStrictEqual(q1.id, q2.id);
  });

  it("propagates optional fields correctly", () => {
    const q = newQuestion({
      question: "Pick a color?",
      defaultAnswer: "Blue",
      options: ["Red", "Green", "Blue"],
      askedDuringTurn: "turn-xyz",
    });
    assert.deepStrictEqual(q.options, ["Red", "Green", "Blue"]);
    assert.strictEqual(q.askedDuringTurn, "turn-xyz");
  });

  it("omits optional fields when not provided", () => {
    const q = newQuestion({
      question: "Are you ready?",
      defaultAnswer: "Yes",
    });
    assert.strictEqual(q.options, undefined);
    assert.strictEqual(q.askedDuringTurn, undefined);
  });
});
