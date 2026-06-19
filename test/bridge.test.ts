import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// Shape matching TransformerClient's public API that the bridge uses.
interface TransformerClientStub extends EventEmitter {
  intercepts: string[];
  start(): void;
  stop(): void;
  reply(id: number | string, payload: unknown): void;
  replyError(id: number | string, code: number, message: string): void;
  request(method: string, params: unknown): Promise<unknown>;
  _lastReply?: { id: number | string; payload: unknown };
  _lastReplyError?: { id: number | string; code: number; message: string };
  _lastRequest?: { method: string; params: unknown };
}

// We import the bridge module to verify its structure. The real TransformerClient
// is used in production; here we only test that ClarifierBridge exposes the
// expected public surface and that its intercepts list has the right shape.
const { ClarifierBridge, CLARIFIER_INTERCEPTS: EXPECTED_INTERCEPTS } = await import("../src/bridge.js");
const { newQuestion } = await import("../src/question.js");
const { saveQuestions } = await import("../src/store.js");

function makeStubClient(): TransformerClientStub {
  const client = new EventEmitter() as unknown as TransformerClientStub;
  client.intercepts = [];
  client.start = () => {};
  client.stop = () => {};
  client.reply = (id, payload) => {
    client._lastReply = { id, payload };
  };
  client.replyError = (id, code, message) => {
    client._lastReplyError = { id, code, message };
  };
  client._requestLog = [];
  client.request = async (method, params) => {
    client._requestLog.push({ method, params });
    return { ok: true };
  };
  return client;
}

describe("ClarifierBridge — construction", () => {
  it("does not throw when constructed with options", () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    assert.ok(bridge instanceof ClarifierBridge);
  });

  it("does not perform I/O in constructor (no side effects)", () => {
    // Construction should only create the client instance. No WS connect,
    // no handshake, no registration calls. If this threw or emitted events
    // synchronously, we'd catch it here.
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    assert.ok(bridge);
  });
});

describe("ClarifierBridge — intercepts", () => {
  it("intercepts list has the expected number of entries", () => {
    assert.strictEqual(EXPECTED_INTERCEPTS.length, 6);
  });

  it("intercepts include all required request and lifecycle patterns", () => {
    // Verify the expected intercepts contain both request: and lifecycle: prefixes
    const requestIntercepts = EXPECTED_INTERCEPTS.filter((i) => i.startsWith("request:"));
    const lifecycleIntercepts = EXPECTED_INTERCEPTS.filter((i) => i.startsWith("lifecycle:"));
    assert.strictEqual(requestIntercepts.length, 4); // session/prompt + 3 question methods
    assert.strictEqual(lifecycleIntercepts.length, 2); // opened + closed
  });

  it("each intercept is a non-empty string", () => {
    for (const intercept of EXPECTED_INTERCEPTS) {
      assert.ok(typeof intercept === "string" && intercept.length > 0);
    }
  });
});

describe("ClarifierBridge — dispatch shape", () => {
  it('handleTransformerMessage exists and is callable', () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    assert.strictEqual(typeof (bridge as any).handleTransformerMessage, "function");
  });

  it('handleMcpInvoke exists and is callable', () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    assert.strictEqual(typeof (bridge as any).handleMcpInvoke, "function");
  });

  it("onRequest dispatches hydra-acp/transformer/message to handleTransformerMessage", () => {
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });

    // Replace the internal client with our stub to capture method calls.
    (bridge as any).client = stubClient;

    const req = {
      jsonrpc: "2.0" as const,
      id: 42,
      method: "hydra-acp/transformer/message",
      params: {
        sessionId: "test-session",
        phase: "unknown",
        method: "some/method",
        direction: "inbound",
        envelope: {},
      },
    };

    // Trigger the bridge's onRequest handler directly (simulating daemon delivery)
    (bridge as any).onRequest(req);

    // Unknown phase/method combos in handleTransformerMessage call replyError
    // with method-not-found (-32601). This verifies the dispatch shape works.
    assert.deepStrictEqual(stubClient._lastReplyError, {
      id: 42,
      code: -32601,
      message: "Method not found",
    });
  });

  it("onRequest dispatches hydra-acp/mcp_tools/invoke to handleMcpInvoke", async () => {
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const req = {
      jsonrpc: "2.0" as const,
      id: 99,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        tool: "note_question",
        sessionId: "test-session",
        args: {},
      },
    };

    (bridge as any).onRequest(req);

    // handleMcpInvoke is now async — wait for the reply to arrive
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(stubClient._lastReply.payload);
    const payload = stubClient._lastReply.payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(payload.isError, true);
    assert.ok(typeof payload.content[0].text === "string");
  });

  it("onRequest replies method-not-found for unknown request methods", () => {
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const req = {
      jsonrpc: "2.0" as const,
      id: 7,
      method: "completely/unknown/method",
    } as unknown as { jsonrpc: "2.0"; id: number; method: string; params?: Record<string, unknown> };

    (bridge as any).onRequest(req);

    assert.ok(stubClient._lastReplyError);
    assert.strictEqual(stubClient._lastReplyError.code, -32601);
    assert.strictEqual(stubClient._lastReplyError.message, "Method not found");
  });
});

describe("ClarifierBridge — attention flag", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  it("note_question with one question triggers attention/set", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const reqId = 1;

    const req = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        tool: "note_question",
        sessionId,
        args: {
          question: "What is the capital of France?",
          default_answer: "Paris",
          options: ["Paris", "London", "Berlin"],
        },
      },
    };

    (bridge as any).onRequest(req);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(stubClient._lastReply.payload);
    const payload = stubClient._lastReply.payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(payload.isError, undefined);
    assert.strictEqual(payload.content[0].text, "noted");

    const attentionSetCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall, "expected hydra-acp/attention/set to be called");
    assert.strictEqual(attentionSetCall!.params.sessionId, sessionId);
    assert.strictEqual(attentionSetCall!.params.reason, "questions");
    const setPayload = attentionSetCall!.params.payload as { kind: string; questions: unknown[] };
    assert.strictEqual(setPayload.kind, "questions");
    assert.ok(Array.isArray(setPayload.questions));
    const questions = (attentionSetCall!.params.payload as { questions: unknown[] }).questions;
    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0].question, "What is the capital of France?");
    assert.strictEqual(questions[0].defaultAnswer, "Paris");
    assert.deepStrictEqual(questions[0].options, ["Paris", "London", "Berlin"]);
  });

  it("dismiss_question on the only question triggers attention/clear", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Pre-create a question file so dismiss has something to find
    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const singleQuestion = [{
      id: "q-1",
      question: "Confirm this action?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }];
    writeFileSync(qPath, JSON.stringify(singleQuestion));

    const reqId = 2;

    const req = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        tool: "dismiss_question",
        sessionId,
        args: { id: "q-1" },
      },
    };

    (bridge as any).onRequest(req);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(stubClient._lastReply.payload);
    const payload = stubClient._lastReply.payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(payload.isError, undefined);
    assert.strictEqual(payload.content[0].text, "dismissed");

    const attentionClearCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/clear",
    );
    assert.ok(attentionClearCall, "expected hydra-acp/attention/clear to be called");
    assert.strictEqual(attentionClearCall!.params.sessionId, sessionId);
    assert.strictEqual(attentionClearCall!.params.reason, "questions");

    const attentionSetCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(attentionSetCall, undefined);
  });
});

describe("ClarifierBridge — message/emit notifications", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-emit-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  it("note_question emits message/emit with method=hydra-acp/question/asked", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const reqId = 1;

    const req = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        tool: "note_question",
        sessionId,
        args: {
          question: "Do you want to proceed?",
          default_answer: "Yes",
          options: ["Yes", "No"],
        },
      },
    };

    (bridge as any).onRequest(req);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(stubClient._lastReply.payload);
    const payload = stubClient._lastReply.payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(payload.isError, undefined);
    assert.strictEqual(payload.content[0].text, "noted");

    const emitCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/message/emit",
    );
    assert.ok(emitCall, "expected hydra-acp/message/emit to be called");
    assert.strictEqual(emitCall!.params.sessionId, sessionId);
    assert.strictEqual(emitCall!.params.method, "hydra-acp/question/asked");
    assert.strictEqual(emitCall!.params.route, "daemon");

    const envelope = emitCall!.params.envelope as { sessionId: string; question: unknown };
    assert.strictEqual(envelope.sessionId, sessionId);
    assert.ok(typeof (envelope.question as Record<string, unknown>).id === "string");
    assert.strictEqual((envelope.question as Record<string, unknown>).question, "Do you want to proceed?");
    assert.strictEqual((envelope.question as Record<string, unknown>).defaultAnswer, "Yes");
    assert.deepStrictEqual((envelope.question as Record<string, unknown>).options, ["Yes", "No"]);
    assert.strictEqual(typeof (envelope.question as Record<string, unknown>).askedAt, "number");
    assert.strictEqual((envelope.question as Record<string, unknown>).status, "open");
  });

  it("dismiss_question emits message/emit with method=hydra-acp/question/dismissed", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    // Pre-create a question file so dismiss has something to find
    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const singleQuestion = [{
      id: "q-dismiss-test",
      question: "Confirm this action?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }];
    writeFileSync(qPath, JSON.stringify(singleQuestion));

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const reqId = 2;

    const req = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "hydra-acp/mcp_tools/invoke",
      params: {
        tool: "dismiss_question",
        sessionId,
        args: { id: "q-dismiss-test" },
      },
    };

    (bridge as any).onRequest(req);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(stubClient._lastReply.payload);
    const payload = stubClient._lastReply.payload as { content: Array<{ text: string }>; isError?: boolean };
    assert.strictEqual(payload.isError, undefined);
    assert.strictEqual(payload.content[0].text, "dismissed");

    const emitCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/message/emit",
    );
    assert.ok(emitCall, "expected hydra-acp/message/emit to be called");
    assert.strictEqual(emitCall!.params.sessionId, sessionId);
    assert.strictEqual(emitCall!.params.method, "hydra-acp/question/dismissed");
    assert.strictEqual(emitCall!.params.route, "daemon");

    const envelope = emitCall!.params.envelope as { sessionId: string; questionId: string; by: string };
    assert.strictEqual(envelope.sessionId, sessionId);
    assert.strictEqual(envelope.questionId, "q-dismiss-test");
    assert.strictEqual(envelope.by, "agent");
  });
});

describe("ClarifierBridge — handleAnswer (inbound /answer)", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-answer-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  function makeAnswerReq(sessionId: string, questionId: string, answer: string): Record<string, unknown> {
    return {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "hydra-acp/transformer/message",
      params: {
        sessionId,
        phase: "request",
        method: "hydra-acp/question/answer",
        envelope: { questionId, answer },
      },
    };
  }

  it("deviation → status=pending-delivery, emit fired, attention republished", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const question = [{
      id: "q-1",
      question: "Use US dollars?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }];
    writeFileSync(qPath, JSON.stringify(question));

    (bridge as any).onRequest(makeAnswerReq(sessionId, "q-1", "No"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });

    const saved = JSON.parse(readFileSync(qPath, "utf-8")) as typeof question;
    assert.strictEqual(saved[0].status, "pending-delivery");
    assert.strictEqual(saved[0].userAnswer, "No");
    assert.strictEqual(saved[0].deviated, true);
    assert.strictEqual(saved[0].closureReason, undefined);

    const emitCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/message/emit",
    );
    assert.ok(emitCall);
    assert.strictEqual(emitCall!.params.sessionId, sessionId);
    assert.strictEqual(emitCall!.params.method, "hydra-acp/question/answered");
    const env = emitCall!.params.envelope as { questionId: string; userAnswer: string; deviated: boolean };
    assert.strictEqual(env.questionId, "q-1");
    assert.strictEqual(env.userAnswer, "No");
    assert.strictEqual(env.deviated, true);

    const attentionSetCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall);
  });

  it("kept default → status=closed with default-accepted, no further injection", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const question = [{
      id: "q-2",
      question: "Use US dollars?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }];
    writeFileSync(qPath, JSON.stringify(question));

    (bridge as any).onRequest(makeAnswerReq(sessionId, "q-2", "Yes"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });

    const saved = JSON.parse(readFileSync(qPath, "utf-8")) as typeof question;
    assert.strictEqual(saved[0].status, "closed");
    assert.strictEqual(saved[0].userAnswer, "Yes");
    assert.strictEqual(saved[0].deviated, false);
    assert.strictEqual(saved[0].closureReason, "default-accepted");

    const attentionClearCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/clear",
    );
    assert.ok(attentionClearCall);
  });

  it("unknown questionId → InvalidParams error reply", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;

    (bridge as any).onRequest(makeAnswerReq(sessionId, "nonexistent", "No"));
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(stubClient._lastReplyError);
    assert.strictEqual(stubClient._lastReplyError.code, -32602);
  });

  it("answering an already-closed question is refused with InvalidParams (no state change)", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();
    const bridge = new ClarifierBridge({ daemonWsUrl: "ws://stub", token: "stub" });
    (bridge as any).client = stubClient;
    const sessionId = "session-answer-already-closed";
    const question = [
      {
        id: "q-locked",
        question: "Q",
        defaultAnswer: "yes",
        askedAt: Date.now(),
        status: "closed" as const,
        closureReason: "default-accepted" as const,
      },
    ];
    const qPath = resolve(
      tmpHome,
      "sessions",
      sessionId,
      "clarifier-questions.json",
    );
    mkdirSync(dirname(qPath), { recursive: true });
    writeFileSync(qPath, JSON.stringify(question));

    (bridge as any).onRequest(makeAnswerReq(sessionId, "q-locked", "no"));
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(stubClient._lastReplyError, "expected error reply");
    assert.strictEqual(stubClient._lastReplyError.code, -32602);

    // On-disk state must be unchanged.
    const saved = JSON.parse(readFileSync(qPath, "utf-8")) as typeof question;
    assert.strictEqual(saved[0].status, "closed");
    assert.strictEqual(saved[0].closureReason, "default-accepted");
    assert.strictEqual(saved[0].userAnswer, undefined);
  });
});

describe("ClarifierBridge — handleDismiss (inbound /dismiss)", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-dismiss-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  function makeDismissReq(sessionId: string, questionId: string): Record<string, unknown> {
    return {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "hydra-acp/transformer/message",
      params: {
        sessionId,
        phase: "request",
        method: "hydra-acp/question/dismiss",
        envelope: { questionId },
      },
    };
  }

  it("marks question closed with dismissed reason", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const question = [{
      id: "q-dismiss-inbound",
      question: "Proceed?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }];
    writeFileSync(qPath, JSON.stringify(question));

    (bridge as any).onRequest(makeDismissReq(sessionId, "q-dismiss-inbound"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });

    const saved = JSON.parse(readFileSync(qPath, "utf-8")) as typeof question;
    assert.strictEqual(saved[0].status, "closed");
    assert.strictEqual(saved[0].closureReason, "dismissed");

    const emitCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/message/emit",
    );
    assert.ok(emitCall);
    assert.strictEqual(emitCall!.params.method, "hydra-acp/question/dismissed");
    const env = emitCall!.params.envelope as { by: string };
    assert.strictEqual(env.by, "user");

    const attentionClearCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/clear",
    );
    assert.ok(attentionClearCall);
  });

  it("dismissing an already-closed question is idempotent (reply is action:stop, no further wire calls)", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();
    const bridge = new ClarifierBridge({ daemonWsUrl: "ws://stub", token: "stub" });
    (bridge as any).client = stubClient;
    const sessionId = "session-dismiss-idempotent";
    const question = [
      {
        id: "q-already-closed",
        question: "Q",
        defaultAnswer: "yes",
        askedAt: Date.now(),
        status: "closed" as const,
        closureReason: "dismissed" as const,
      },
    ];
    const qPath = resolve(
      tmpHome,
      "sessions",
      sessionId,
      "clarifier-questions.json",
    );
    mkdirSync(dirname(qPath), { recursive: true });
    writeFileSync(qPath, JSON.stringify(question));

    (bridge as any).onRequest(makeDismissReq(sessionId, "q-already-closed"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });
    const emitCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/message/emit",
    );
    assert.strictEqual(emitCall, undefined, "no notification should fire for an idempotent dismiss");
  });
});

describe("ClarifierBridge — handleList (inbound /list)", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-list-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  function makeListReq(sessionId: string): Record<string, unknown> {
    return {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "hydra-acp/transformer/message",
      params: {
        sessionId,
        phase: "request",
        method: "hydra-acp/question/list",
        envelope: {},
      },
    };
  }

  it("returns correct shape with active questions only", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const questions = [
      {
        id: "q-open",
        question: "Open question?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "open",
      },
      {
        id: "q-pending",
        question: "Pending question?",
        defaultAnswer: "No",
        askedAt: Date.now(),
        status: "pending-delivery",
      },
      {
        id: "q-closed",
        question: "Closed question?",
        defaultAnswer: "Maybe",
        askedAt: Date.now(),
        status: "closed",
        closureReason: "default-accepted",
      },
    ];
    writeFileSync(qPath, JSON.stringify(questions));

    (bridge as any).onRequest(makeListReq(sessionId));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { questions: [questions[0], questions[1]] },
    });
  });
});

describe("ClarifierBridge — handlePromptIntercept (session/prompt)", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-prompt-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  function makePromptReq(
    sessionId: string,
    promptBlocks?: unknown[],
  ): Record<string, unknown> {
    return {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "hydra-acp/transformer/message",
      params: {
        sessionId,
        phase: "request",
        method: "session/prompt",
        envelope: { sessionId, prompt: promptBlocks ?? [] },
      },
    };
  }

  it("no pending-delivery deviations → reply {action:'continue'} with no payload", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const questions = [
      {
        id: "q-open",
        question: "Proceed?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "open",
      },
      {
        id: "q-closed",
        question: "Use currency?",
        defaultAnswer: "USD",
        askedAt: Date.now(),
        status: "closed",
        closureReason: "default-accepted",
      },
    ];
    writeFileSync(qPath, JSON.stringify(questions));

    (bridge as any).onRequest(makePromptReq(sessionId, [{ type: "text", text: "Hello" }]));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(stubClient._lastReply.payload, { action: "continue" });
  });

  it("one deviation → reply has rewritten envelope, deviation block is first prompt block, question transitions to closed", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const questions = [
      {
        id: "q-1",
        question: "Use US dollars?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "pending-delivery",
        userAnswer: "No",
        deviated: true,
      },
    ];
    writeFileSync(qPath, JSON.stringify(questions));

    const originalPrompt = [{ type: "text", text: "Tell me about pricing." }];
    (bridge as any).onRequest(makePromptReq(sessionId, originalPrompt));
    await new Promise((r) => setTimeout(r, 100));

    const payload = stubClient._lastReply.payload as { action: string; payload?: unknown };
    assert.strictEqual(payload.action, "continue");
    assert.ok(payload.payload);

    const rewritten = payload.payload as Record<string, unknown>;
    assert.strictEqual(rewritten.sessionId, sessionId);
    const newPrompt = rewritten.prompt as unknown[];
    assert.ok(Array.isArray(newPrompt));
    assert.strictEqual(newPrompt.length, 2);

    const firstBlock = newPrompt[0] as { type: string; text: string };
    assert.strictEqual(firstBlock.type, "text");
    assert.ok(
      firstBlock.text.includes("Answers to your earlier questions"),
      "deviation block should be present",
    );
    assert.ok(
      firstBlock.text.includes("Use US dollars?"),
      "question text should appear in deviation block",
    );
    assert.ok(
      firstBlock.text.includes("No"),
      "user answer should appear in deviation block",
    );

    const secondBlock = newPrompt[1] as { type: string; text?: string };
    assert.strictEqual(secondBlock.type, "text");
    assert.strictEqual(secondBlock.text, "Tell me about pricing.");

    // Verify question transitioned to closed with deviation-delivered reason
    const saved = JSON.parse(readFileSync(qPath, "utf-8")) as typeof questions;
    assert.strictEqual(saved[0].status, "closed");
    assert.strictEqual(saved[0].closureReason, "deviation-delivered");

    // attention flag should be cleared (no more active questions)
    const attentionClearCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/clear",
    );
    assert.ok(attentionClearCall);
  });

  it("multiple deviations → all listed in one block, all transition to closed", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const questions = [
      {
        id: "q-m1",
        question: "Use US dollars?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "pending-delivery",
        userAnswer: "No",
        deviated: true,
      },
      {
        id: "q-m2",
        question: "Include tax?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "pending-delivery",
        userAnswer: "No",
        deviated: true,
      },
    ];
    writeFileSync(qPath, JSON.stringify(questions));

    const originalPrompt = [{ type: "text", text: "Calculate total." }];
    (bridge as any).onRequest(makePromptReq(sessionId, originalPrompt));
    await new Promise((r) => setTimeout(r, 100));

    const payload = stubClient._lastReply.payload as { action: string; payload?: unknown };
    assert.strictEqual(payload.action, "continue");
    assert.ok(payload.payload);

    const rewritten = payload.payload as Record<string, unknown>;
    const newPrompt = rewritten.prompt as unknown[];
    assert.ok(Array.isArray(newPrompt));
    assert.strictEqual(newPrompt.length, 2);

    const firstBlock = newPrompt[0] as { type: string; text: string };
    assert.strictEqual(firstBlock.type, "text");
    assert.ok(
      firstBlock.text.includes("Use US dollars?"),
      "first question should be in deviation block",
    );
    assert.ok(
      firstBlock.text.includes("Include tax?"),
      "second question should be in deviation block",
    );
    assert.ok(
      firstBlock.text.includes("No"),
      "both user answers should appear",
    );

    const saved = JSON.parse(readFileSync(qPath, "utf-8")) as typeof questions;
    assert.strictEqual(saved[0].status, "closed");
    assert.strictEqual(saved[0].closureReason, "deviation-delivered");
    assert.strictEqual(saved[1].status, "closed");
    assert.strictEqual(saved[1].closureReason, "deviation-delivered");

    const attentionClearCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/clear",
    );
    assert.ok(attentionClearCall);
  });

  it("keeps-defaulted question is not injected (status=closed, not pending-delivery)", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const questions = [
      {
        id: "q-kept",
        question: "Use US dollars?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "closed",
        closureReason: "default-accepted",
        userAnswer: "Yes",
        deviated: false,
      },
    ];
    writeFileSync(qPath, JSON.stringify(questions));

    (bridge as any).onRequest(makePromptReq(sessionId, [{ type: "text", text: "Hello" }]));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(stubClient._lastReply.payload, { action: "continue" });
  });

  it("attention flag is republished after injection", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const questions = [
      {
        id: "q-1",
        question: "Confirm?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "pending-delivery",
        userAnswer: "No",
        deviated: true,
      },
    ];
    writeFileSync(qPath, JSON.stringify(questions));

    (bridge as any).onRequest(makePromptReq(sessionId, [{ type: "text", text: "Go" }]));
    await new Promise((r) => setTimeout(r, 100));

    const attentionCall = stubClient._requestLog.find(
      (r) => r.method === "hydra-acp/attention/clear",
    );
    assert.ok(attentionCall);
    const clearParams = attentionCall!.params as Record<string, unknown>;
    assert.strictEqual(clearParams.sessionId, sessionId);
    assert.strictEqual(clearParams.reason, "questions");
  });

  it("does not mutate the original envelope object", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    const qPath = resolve(questionsDir, "clarifier-questions.json");
    const questions = [
      {
        id: "q-immutable",
        question: "Proceed?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "pending-delivery",
        userAnswer: "No",
        deviated: true,
      },
    ];
    writeFileSync(qPath, JSON.stringify(questions));

    const originalPrompt = [{ type: "text", text: "Hello" }];
    const snapshotLength = originalPrompt.length;
    (bridge as any).onRequest(makePromptReq(sessionId, originalPrompt));
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(
      originalPrompt.length,
      snapshotLength,
      "original prompt array should not be mutated",
    );
  });
});

describe("ClarifierBridge — startup reconcile", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-reconcile-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  it("reconcile republishes exactly one attention flag when one session has open questions and another has all closed", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Session A: has an open question → should trigger attention/set
    const sessionA = `session-reconcile-a-${Date.now()}`;
    const dirA = resolve(tmpHome, "sessions", sessionA);
    mkdirSync(dirA, { recursive: true });
    writeFileSync(
      resolve(dirA, "clarifier-questions.json"),
      JSON.stringify([{
        id: "q-a1",
        question: "Proceed with A?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "open",
      }]),
    );

    // Session B: all questions closed → should NOT trigger attention/set
    const sessionB = `session-reconcile-b-${Date.now()}`;
    const dirB = resolve(tmpHome, "sessions", sessionB);
    mkdirSync(dirB, { recursive: true });
    writeFileSync(
      resolve(dirB, "clarifier-questions.json"),
      JSON.stringify([{
        id: "q-b1",
        question: "Done with B?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "closed",
        closureReason: "default-accepted",
      }]),
    );

    await (bridge as any).reconcile();
    await new Promise((r) => setTimeout(r, 100));

    const attentionSetCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(attentionSetCalls.length, 1, "expected exactly one attention/set call");
    assert.strictEqual(attentionSetCalls[0].params.sessionId, sessionA);

    const attentionClearCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionClearCalls.length, 1, "expected exactly one attention/clear call for session B");
    assert.strictEqual(attentionClearCalls[0].params.sessionId, sessionB);
  });

  it("reconcile skips non-directory entries in sessions dir", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Create a session directory with an open question
    const sessionId = `session-skip-${Date.now()}`;
    const dir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "clarifier-questions.json"),
      JSON.stringify([{
        id: "q-skip",
        question: "Skip test?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "open",
      }]),
    );

    // Create a non-directory file in sessions dir that should be ignored
    const fakeFile = resolve(tmpHome, "sessions", "not-a-session.json");
    writeFileSync(fakeFile, JSON.stringify([]));

    await (bridge as any).reconcile();
    await new Promise((r) => setTimeout(r, 100));

    const attentionSetCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(attentionSetCalls.length, 1);
    assert.strictEqual(attentionSetCalls[0].params.sessionId, sessionId);

    await rm(fakeFile, { force: true });
  });

  it("reconcile does not throw on per-session errors (bad JSON)", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Session with bad JSON → should be logged but not abort reconcile
    const badSession = `session-bad-${Date.now()}`;
    const badDir = resolve(tmpHome, "sessions", badSession);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(resolve(badDir, "clarifier-questions.json"), "NOT VALID JSON{{{");

    // Session with valid open question → should still be processed
    const goodSession = `session-good-${Date.now()}`;
    const goodDir = resolve(tmpHome, "sessions", goodSession);
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(
      resolve(goodDir, "clarifier-questions.json"),
      JSON.stringify([{
        id: "q-good",
        question: "Good question?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "open",
      }]),
    );

    // Should not throw
    await (bridge as any).reconcile();
    await new Promise((r) => setTimeout(r, 100));

    const attentionSetCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(attentionSetCalls.length, 1);
    assert.strictEqual(attentionSetCalls[0].params.sessionId, goodSession);
  });

  it("reconcile skips sessions with no questions file", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Session dir exists but no questions file → loadQuestions returns []
    const emptySession = `session-empty-${Date.now()}`;
    const emptyDir = resolve(tmpHome, "sessions", emptySession);
    mkdirSync(emptyDir, { recursive: true });

    await (bridge as any).reconcile();
    await new Promise((r) => setTimeout(r, 100));

    const attentionSetCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(attentionSetCalls.length, 0);
  });
});

describe("ClarifierBridge — lifecycle event handlers", () => {
  let tmpHome: string;

  function setupTmpHome(): void {
    const base = resolve(tmpdir(), "clarifier-lifecycle-test-");
    const randomDir = `${base}${Math.random().toString(36).slice(2)}`;
    tmpHome = randomDir;
    mkdirSync(randomDir, { recursive: true });
    process.env.HYDRA_ACP_HOME = tmpHome;
  }

  afterEach(async () => {
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
    delete process.env.HYDRA_ACP_HOME;
  });

  it("session.opened triggers publishAttentionFlag for that session", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Pre-create a session with an open question
    const sessionId = `session-lifecycle-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    writeFileSync(
      resolve(questionsDir, "clarifier-questions.json"),
      JSON.stringify([{
        id: "q-lifecycle",
        question: "Lifecycle test?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "open",
      }]),
    );

    const notification = {
      jsonrpc: "2.0" as const,
      method: "hydra-acp/transformer/session_event",
      params: { event: "session.opened", sessionId },
    };

    (bridge as any).onNotification(notification);
    await new Promise((r) => setTimeout(r, 100));

    const attentionSetCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(attentionSetCalls.length, 1);
    assert.strictEqual(attentionSetCalls[0].params.sessionId, sessionId);
    assert.strictEqual(attentionSetCalls[0].params.reason, "questions");
  });

  it("session.closed does not trigger any WS call", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Pre-create a session with an open question so there's state to potentially surface
    const sessionId = `session-closed-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    writeFileSync(
      resolve(questionsDir, "clarifier-questions.json"),
      JSON.stringify([{
        id: "q-closed-test",
        question: "Closed test?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "open",
      }]),
    );

    const notification = {
      jsonrpc: "2.0" as const,
      method: "hydra-acp/transformer/session_event",
      params: { event: "session.closed", sessionId },
    };

    (bridge as any).onNotification(notification);
    await new Promise((r) => setTimeout(r, 100));

    const attentionCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/set" || r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionCalls.length, 0, "session.closed should not trigger any attention WS call");
  });

  it("session.opened with no open questions triggers attention/clear", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Session with all closed questions
    const sessionId = `session-cleared-${Date.now()}`;
    const questionsDir = resolve(tmpHome, "sessions", sessionId);
    mkdirSync(questionsDir, { recursive: true });
    writeFileSync(
      resolve(questionsDir, "clarifier-questions.json"),
      JSON.stringify([{
        id: "q-cleared",
        question: "All done?",
        defaultAnswer: "Yes",
        askedAt: Date.now(),
        status: "closed",
        closureReason: "default-accepted",
      }]),
    );

    const notification = {
      jsonrpc: "2.0" as const,
      method: "hydra-acp/transformer/session_event",
      params: { event: "session.opened", sessionId },
    };

    (bridge as any).onNotification(notification);
    await new Promise((r) => setTimeout(r, 100));

    const attentionClearCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionClearCalls.length, 1);
    assert.strictEqual(attentionClearCalls[0].params.sessionId, sessionId);

    const attentionSetCalls = stubClient._requestLog.filter(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(attentionSetCalls.length, 0);
  });

  it("ignores unknown lifecycle events", async () => {
    setupTmpHome();
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const notification = {
      jsonrpc: "2.0" as const,
      method: "hydra-acp/transformer/session_event",
      params: { event: "session.unknown_event", sessionId: "test-session" },
    };

    (bridge as any).onNotification(notification);
    await new Promise((r) => setTimeout(r, 50));

    // No WS calls should be made for unknown events
    assert.strictEqual(stubClient._requestLog.length, 0);
  });
});

describe("ClarifierBridge — error event handling", () => {
  it("attaches an 'error' listener so an emitted error does not crash the process", () => {
    const stubClient = makeStubClient();
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://stub",
      token: "stub",
    });
    (bridge as any).client = stubClient;

    // Call start() to register listeners. The stub's start() is a no-op,
    // so no actual WS work happens — but the bridge.on(...) calls run.
    (bridge as any).start();

    // EventEmitter throws 'Unhandled error' synchronously when there's no
    // listener. If the bridge dropped the error listener (regression), this
    // emit would propagate as an uncaught exception and the test runner
    // would fail with an unhandled-error report.
    assert.doesNotThrow(() => {
      (stubClient as unknown as EventEmitter).emit("error", new Error("simulated ws hang up"));
    });
  });
});
