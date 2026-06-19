import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CLARIFIER_MCP_INSTRUCTIONS, CLARIFIER_MCP_TOOLS } from "../src/mcp-tools.js";
import { newQuestion } from "../src/question.js";

// ── MCP tool specs ───────────────────────────────────────────────

describe("CLARIFIER_MCP_TOOLS", () => {
  it("has exactly 3 entries", () => {
    assert.strictEqual(CLARIFIER_MCP_TOOLS.length, 3);
  });

  it("includes note_question, list_open_questions, and dismiss_question", () => {
    const names = CLARIFIER_MCP_TOOLS.map((t) => t.name);
    assert.ok(names.includes("note_question"));
    assert.ok(names.includes("list_open_questions"));
    assert.ok(names.includes("dismiss_question"));
  });

  it("each tool has name, description, and inputSchema", () => {
    for (const tool of CLARIFIER_MCP_TOOLS) {
      assert.ok(typeof tool.name === "string" && tool.name.length > 0);
      assert.ok(typeof tool.description === "string" && tool.description.length > 0);
      assert.ok(
        typeof tool.inputSchema === "object" && tool.inputSchema !== null,
        `${tool.name}.inputSchema must be an object`,
      );
    }
  });

  it("each inputSchema is a valid JSON Schema (has type: object)", () => {
    for (const tool of CLARIFIER_MCP_TOOLS) {
      assert.strictEqual(tool.inputSchema.type, "object");
      assert.ok(
        typeof tool.inputSchema.properties === "object" && tool.inputSchema.properties !== null,
        `${tool.name}.inputSchema.properties must be an object`,
      );
    }
  });

  it("note_question schema requires question and default_answer", () => {
    const noteTool = CLARIFIER_MCP_TOOLS.find((t) => t.name === "note_question")!;
    assert.deepStrictEqual(noteTool.inputSchema.required, ["question", "default_answer"]);
    assert.strictEqual(
      noteTool.inputSchema.properties.question.type,
      "string",
    );
    assert.strictEqual(
      noteTool.inputSchema.properties.default_answer.type,
      "string",
    );
    assert.strictEqual(
      noteTool.inputSchema.properties.options?.type,
      "array",
    );
  });

  it("list_open_questions schema has no required fields", () => {
    const listTool = CLARIFIER_MCP_TOOLS.find((t) => t.name === "list_open_questions")!;
    assert.deepStrictEqual(listTool.inputSchema.required, undefined);
  });

  it("dismiss_question schema requires id", () => {
    const dismissTool = CLARIFIER_MCP_TOOLS.find((t) => t.name === "dismiss_question")!;
    assert.deepStrictEqual(dismissTool.inputSchema.required, ["id"]);
    assert.strictEqual(
      dismissTool.inputSchema.properties.id.type,
      "string",
    );
  });

  it("CLARIFIER_MCP_INSTRUCTIONS is a non-empty string with workflow guidance", () => {
    assert.ok(typeof CLARIFIER_MCP_INSTRUCTIONS === "string");
    assert.ok(CLARIFIER_MCP_INSTRUCTIONS.length > 0);
    assert.ok(
      CLARIFIER_MCP_INSTRUCTIONS.toLowerCase().includes("note_question"),
      "instructions should mention note_question",
    );
    assert.ok(
      CLARIFIER_MCP_INSTRUCTIONS.toLowerCase().includes("do not block"),
      "instructions should say not to block the turn",
    );
  });
});

// ── Bridge handler integration tests (via real store) ────────────

interface ReplyCapture {
  id: number | string;
  payload: unknown;
}

function makeStubClient() {
  const replies: ReplyCapture[] = [];
  const lastReply: { id: number | string; payload: unknown } = { id: 0, payload: null };
  return {
    emit: () => {},
    on: () => {},
    start: () => {},
    stop: () => {},
    reply(id: number | string, payload: unknown) {
      replies.push({ id, payload });
      lastReply.id = id;
      lastReply.payload = payload;
    },
    _replies: replies,
    _lastReply: lastReply,
  };
}

function loadBridge() {
  return import("../src/bridge.js");
}

describe("handleMcpInvoke — note_question", () => {
  let home: string;
  let sessionId: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hydra-acp-mcp-test-"));
    sessionId = `test-nq-${Date.now()}`;
    origHome = process.env.HYDRA_ACP_HOME;
    process.env.HYDRA_ACP_HOME = home;
  });

  afterEach(async () => {
    if (origHome !== undefined) {
      process.env.HYDRA_ACP_HOME = origHome;
    } else {
      delete process.env.HYDRA_ACP_HOME;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("appends a new question to the store and replies 'noted'", async () => {
    const { ClarifierBridge } = await loadBridge();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    // Inject a stub client that captures replies
    const stubClient = makeStubClient();
    (bridge as any).client = {
      ...stubClient,
      start: () => {},
      stop: () => {},
    };

    // Call handleMcpInvoke directly
    const req = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        sessionId,
        tool: "note_question",
        args: {
          question: "What is the capital of France?",
          default_answer: "Paris",
          options: ["Paris", "Lyon", "Marseille"],
        },
      },
    };

    await (bridge as any).handleMcpInvoke(req);

    assert.strictEqual(stubClient._replies.length, 1);
    const reply = stubClient._replies[0].payload as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.strictEqual(reply.isError, undefined);
    assert.strictEqual(reply.content[0].type, "text");
    assert.strictEqual(reply.content[0].text, "noted");

    // Verify the question was persisted to the store
    const { loadQuestions } = await import("../src/store.js");
    const questions = await loadQuestions(sessionId);
    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0].question, "What is the capital of France?");
    assert.strictEqual(questions[0].defaultAnswer, "Paris");
    assert.deepStrictEqual(questions[0].options, ["Paris", "Lyon", "Marseille"]);
    assert.strictEqual(questions[0].status, "open");
  });

  it("replies error when question or default_answer is missing", async () => {
    const { ClarifierBridge } = await loadBridge();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    const stubClient = makeStubClient();
    (bridge as any).client = {
      ...stubClient,
      start: () => {},
      stop: () => {},
    };

    const req = {
      jsonrpc: "2.0" as const,
      id: 2,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        sessionId,
        tool: "note_question",
        args: { question: "Missing default" },
      },
    };

    await (bridge as any).handleMcpInvoke(req);

    const reply = stubClient._replies[0].payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(reply.isError, true);
  });
});

describe("handleMcpInvoke — list_open_questions", () => {
  let home: string;
  let sessionId: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hydra-acp-mcp-test-"));
    sessionId = `test-loq-${Date.now()}`;
    origHome = process.env.HYDRA_ACP_HOME;
    process.env.HYDRA_ACP_HOME = home;
  });

  afterEach(async () => {
    if (origHome !== undefined) {
      process.env.HYDRA_ACP_HOME = origHome;
    } else {
      delete process.env.HYDRA_ACP_HOME;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("returns only open and pending-delivery questions", async () => {
    const { saveQuestions } = await import("../src/store.js");

    const q1 = newQuestion({ question: "Open Q", defaultAnswer: "A" });
    const q2 = newQuestion({ question: "Pending Q", defaultAnswer: "B" });
    const q3 = newQuestion({ question: "Closed Q", defaultAnswer: "C" });
    q3.status = "closed";
    q3.closureReason = "dismissed";

    await saveQuestions(sessionId, [q1, q2, q3]);

    const { ClarifierBridge } = await loadBridge();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    const stubClient = makeStubClient();
    (bridge as any).client = {
      ...stubClient,
      start: () => {},
      stop: () => {},
    };

    const req = {
      jsonrpc: "2.0" as const,
      id: 3,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        sessionId,
        tool: "list_open_questions",
        args: {},
      },
    };

    await (bridge as any).handleMcpInvoke(req);

    const reply = stubClient._replies[0].payload as { content: Array<{ text: string }> };
    const questions = JSON.parse(reply.content[0].text) as Array<{ id: string; status: string }>;
    assert.strictEqual(questions.length, 2);
    const statuses = new Set(questions.map((q) => q.status));
    assert.ok(statuses.has("open"));
    assert.ok(statuses.has("pending-delivery") || statuses.has("open"));
    // Closed question should NOT be included
    assert.ok(!statuses.has("closed"));
  });

  it("returns empty array when no questions exist", async () => {
    const { ClarifierBridge } = await loadBridge();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    const stubClient = makeStubClient();
    (bridge as any).client = {
      ...stubClient,
      start: () => {},
      stop: () => {},
    };

    const req = {
      jsonrpc: "2.0" as const,
      id: 4,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        sessionId,
        tool: "list_open_questions",
        args: {},
      },
    };

    await (bridge as any).handleMcpInvoke(req);

    const reply = stubClient._replies[0].payload as { content: Array<{ text: string }> };
    const questions = JSON.parse(reply.content[0].text) as unknown[];
    assert.strictEqual(questions.length, 0);
  });
});

describe("handleMcpInvoke — dismiss_question", () => {
  let home: string;
  let sessionId: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hydra-acp-mcp-test-"));
    sessionId = `test-dq-${Date.now()}`;
    origHome = process.env.HYDRA_ACP_HOME;
    process.env.HYDRA_ACP_HOME = home;
  });

  afterEach(async () => {
    if (origHome !== undefined) {
      process.env.HYDRA_ACP_HOME = origHome;
    } else {
      delete process.env.HYDRA_ACP_HOME;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("marks a question as closed with dismissal reason", async () => {
    const { saveQuestions, loadQuestions } = await import("../src/store.js");

    const q = newQuestion({ question: "Dismiss me", defaultAnswer: "No" });
    await saveQuestions(sessionId, [q]);

    const { ClarifierBridge } = await loadBridge();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    const stubClient = makeStubClient();
    (bridge as any).client = {
      ...stubClient,
      start: () => {},
      stop: () => {},
    };

    const req = {
      jsonrpc: "2.0" as const,
      id: 5,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        sessionId,
        tool: "dismiss_question",
        args: { id: q.id },
      },
    };

    await (bridge as any).handleMcpInvoke(req);

    const reply = stubClient._replies[0].payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(reply.isError, undefined);
    assert.strictEqual(reply.content[0].text, "dismissed");

    // Verify persistence
    const questions = await loadQuestions(sessionId);
    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0].status, "closed");
    assert.strictEqual(questions[0].closureReason, "dismissed");
  });

  it("returns error for unknown id", async () => {
    const { saveQuestions } = await import("../src/store.js");

    // Save a question with a different id
    const q = newQuestion({ question: "Different Q", defaultAnswer: "A" });
    await saveQuestions(sessionId, [q]);

    const { ClarifierBridge } = await loadBridge();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    const stubClient = makeStubClient();
    (bridge as any).client = {
      ...stubClient,
      start: () => {},
      stop: () => {},
    };

    const req = {
      jsonrpc: "2.0" as const,
      id: 6,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        sessionId,
        tool: "dismiss_question",
        args: { id: "nonexistent-id-00000" },
      },
    };

    await (bridge as any).handleMcpInvoke(req);

    const reply = stubClient._replies[0].payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(reply.isError, true);
  });

  it("returns error when id is missing", async () => {
    const { ClarifierBridge } = await loadBridge();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    const stubClient = makeStubClient();
    (bridge as any).client = {
      ...stubClient,
      start: () => {},
      stop: () => {},
    };

    const req = {
      jsonrpc: "2.0" as const,
      id: 7,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        sessionId,
        tool: "dismiss_question",
        args: {},
      },
    };

    await (bridge as any).handleMcpInvoke(req);

    const reply = stubClient._replies[0].payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(reply.isError, true);
  });
});
