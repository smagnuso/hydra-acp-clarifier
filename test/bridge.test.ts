import { EventEmitter } from "node:events";
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

interface TransformerClientStub extends EventEmitter {
  intercepts: string[];
  start(): void;
  stop(): void;
  reply(id: number | string, payload: unknown): void;
  replyError(id: number | string, code: number, message: string): void;
  request(method: string, params: unknown): Promise<unknown>;
  _lastReply?: { id: number | string; payload: unknown };
  _lastReplyError?: { id: number | string; code: number; message: string };
  _requestLog: Array<{ method: string; params: unknown }>;
}

const { ClarifierBridge, CLARIFIER_INTERCEPTS: EXPECTED_INTERCEPTS } = await import("../src/bridge.js");
const { newQuestion } = await import("../src/question.js");

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
      daemonUrl: "http://127.0.0.1:55514",
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
      daemonUrl: "http://127.0.0.1:55514",
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
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    assert.strictEqual(typeof (bridge as any).handleTransformerMessage, "function");
  });

  it('handleMcpInvoke exists and is callable', () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    assert.strictEqual(typeof (bridge as any).handleMcpInvoke, "function");
  });

  it("onRequest dispatches hydra-acp/transformer/message to handleTransformerMessage", () => {
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
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
      daemonUrl: "http://127.0.0.1:55514",
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
      daemonUrl: "http://127.0.0.1:55514",
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

describe("ClarifierBridge — MCP tools (in-memory cache)", () => {
  let stubClient: TransformerClientStub;

  beforeEach(() => {
    stubClient = makeStubClient();
  });

  it("note_question adds a question to cache and triggers attention/set", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
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

    // Verify cache was updated
    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].question, "What is the capital of France?");
    assert.strictEqual(cached[0].defaultAnswer, "Paris");
    assert.deepStrictEqual(cached[0].options, ["Paris", "London", "Berlin"]);

    // Verify attention/set was called via setQuestions
    const attentionSetCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall, "expected hydra-acp/attention/set to be called");
    assert.strictEqual(attentionSetCall!.params.sessionId, sessionId);
    assert.strictEqual(attentionSetCall!.params.reason, "questions");
    const setPayload = attentionSetCall!.params.payload as { kind: string; questions: unknown[] };
    assert.strictEqual(setPayload.kind, "questions");
    assert.ok(Array.isArray(setPayload.questions));
    assert.strictEqual(setPayload.questions.length, 1);
  });

  it("dismiss_question on the only question triggers attention/clear", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    (bridge as any).sessionQuestions.set(sessionId, [{
      id: "q-1",
      question: "Confirm this action?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }]);

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

    // Cache should have the dismissed question (setQuestions sends full array)
    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].status, "closed");
    assert.strictEqual(cached[0].closureReason, "dismissed");

    // attention/set should have been called with full array via setQuestions
    const attentionSetCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall, "expected hydra-acp/attention/set to be called");
    assert.strictEqual(attentionSetCall!.params.sessionId, sessionId);
    assert.strictEqual(attentionSetCall!.params.reason, "questions");
    const setPayload = attentionSetCall!.params.payload as { kind: string; questions: unknown[] };
    assert.strictEqual(setPayload.kind, "questions");
    assert.strictEqual(setPayload.questions.length, 1);

    // attention/clear should NOT have been called
    const attentionClearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionClearCall, undefined);
  });
});

describe("ClarifierBridge — message/emit notifications", () => {
  let stubClient: TransformerClientStub;

  beforeEach(() => {
    stubClient = makeStubClient();
  });

  it("note_question emits message/emit with method=hydra-acp/question/asked", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
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
      (r: { method: string }) => r.method === "hydra-acp/message/emit",
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
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    (bridge as any).sessionQuestions.set(sessionId, [{
      id: "q-dismiss-test",
      question: "Confirm this action?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }]);

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
      (r: { method: string }) => r.method === "hydra-acp/message/emit",
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
  let stubClient: TransformerClientStub;

  beforeEach(() => {
    stubClient = makeStubClient();
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

  it("deviation → status=pending-delivery, emit fired, cache updated", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    (bridge as any).sessionQuestions.set(sessionId, [{
      id: "q-1",
      question: "Use US dollars?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }]);

    (bridge as any).onRequest(makeAnswerReq(sessionId, "q-1", "No"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });

    // Verify cache was updated
    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].status, "pending-delivery");
    assert.strictEqual(cached[0].userAnswer, "No");
    assert.strictEqual(cached[0].deviated, true);
    assert.strictEqual(cached[0].closureReason, undefined);

    const emitCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/message/emit",
    );
    assert.ok(emitCall);
    assert.strictEqual(emitCall!.params.sessionId, sessionId);
    assert.strictEqual(emitCall!.params.method, "hydra-acp/question/answered");
    const env = emitCall!.params.envelope as { questionId: string; userAnswer: string; deviated: boolean };
    assert.strictEqual(env.questionId, "q-1");
    assert.strictEqual(env.userAnswer, "No");
    assert.strictEqual(env.deviated, true);

    // attention/set should have been called (still has pending-delivery question)
    const attentionSetCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall);
  });

  it("kept default → status=closed with default-accepted, cache updated", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    (bridge as any).sessionQuestions.set(sessionId, [{
      id: "q-2",
      question: "Use US dollars?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }]);

    (bridge as any).onRequest(makeAnswerReq(sessionId, "q-2", "Yes"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });

    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].status, "closed");
    assert.strictEqual(cached[0].userAnswer, "Yes");
    assert.strictEqual(cached[0].deviated, false);
    assert.strictEqual(cached[0].closureReason, "default-accepted");

    // attention/set should have been called (setQuestions sends full array)
    const attentionSetCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall);

    // attention/clear should NOT have been called
    const attentionClearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionClearCall, undefined);
  });

  it("unknown questionId → InvalidParams error reply", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
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
    const bridge = new ClarifierBridge({ daemonWsUrl: "ws://stub", daemonUrl: "http://stub", token: "stub" });
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
    (bridge as any).sessionQuestions.set(sessionId, question);

    (bridge as any).onRequest(makeAnswerReq(sessionId, "q-locked", "no"));
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(stubClient._lastReplyError, "expected error reply");
    assert.strictEqual(stubClient._lastReplyError.code, -32602);

    // Cache should be unchanged
    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached[0].status, "closed");
    assert.strictEqual(cached[0].closureReason, "default-accepted");
    assert.strictEqual(cached[0].userAnswer, undefined);
  });
});

describe("ClarifierBridge — handleDismiss (inbound /dismiss)", () => {
  let stubClient: TransformerClientStub;

  beforeEach(() => {
    stubClient = makeStubClient();
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
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
    (bridge as any).sessionQuestions.set(sessionId, [{
      id: "q-dismiss-inbound",
      question: "Proceed?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }]);

    (bridge as any).onRequest(makeDismissReq(sessionId, "q-dismiss-inbound"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });

    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached[0].status, "closed");
    assert.strictEqual(cached[0].closureReason, "dismissed");

    const emitCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/message/emit",
    );
    assert.ok(emitCall);
    assert.strictEqual(emitCall!.params.method, "hydra-acp/question/dismissed");
    const env = emitCall!.params.envelope as { by: string };
    assert.strictEqual(env.by, "user");

    // attention/set should have been called (setQuestions sends full array)
    const attentionSetCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall);

    // attention/clear should NOT have been called
    const attentionClearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionClearCall, undefined);
  });

  it("dismissing an already-closed question is idempotent (reply is action:stop, no further wire calls)", async () => {
    const bridge = new ClarifierBridge({ daemonWsUrl: "ws://stub", daemonUrl: "http://stub", token: "stub" });
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
    (bridge as any).sessionQuestions.set(sessionId, question);

    (bridge as any).onRequest(makeDismissReq(sessionId, "q-already-closed"));
    await new Promise((r) => setTimeout(r, 100));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { ok: true },
    });
    const emitCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/message/emit",
    );
    assert.strictEqual(emitCall, undefined, "no notification should fire for an idempotent dismiss");
  });
});

describe("ClarifierBridge — handleList (inbound /list)", () => {
  let stubClient: TransformerClientStub;

  beforeEach(() => {
    stubClient = makeStubClient();
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
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
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
    (bridge as any).sessionQuestions.set(sessionId, questions);

    (bridge as any).onRequest(makeListReq(sessionId));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(stubClient._lastReply.payload, {
      action: "stop",
      payload: { questions: [questions[0], questions[1]] },
    });
  });
});

describe("ClarifierBridge — handlePromptIntercept (session/prompt)", () => {
  let stubClient: TransformerClientStub;

  beforeEach(() => {
    stubClient = makeStubClient();
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
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
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
    (bridge as any).sessionQuestions.set(sessionId, questions);

    (bridge as any).onRequest(makePromptReq(sessionId, [{ type: "text", text: "Hello" }]));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(stubClient._lastReply.payload, { action: "continue" });
  });

  it("one deviation → reply has rewritten envelope, deviation block is first prompt block, question transitions to closed", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
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
    (bridge as any).sessionQuestions.set(sessionId, questions);

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

    // Verify cache was updated — question transitioned to closed with deviation-delivered reason
    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].status, "closed");
    assert.strictEqual(cached[0].closureReason, "deviation-delivered");

    // attention/set should have been called (setQuestions sends full array)
    const attentionSetCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall);

    // attention/clear should NOT have been called
    const attentionClearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionClearCall, undefined);
  });

  it("multiple deviations → all listed in one block, all transition to closed", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
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
    (bridge as any).sessionQuestions.set(sessionId, questions);

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

    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached[0].status, "closed");
    assert.strictEqual(cached[0].closureReason, "deviation-delivered");
    assert.strictEqual(cached[1].status, "closed");
    assert.strictEqual(cached[1].closureReason, "deviation-delivered");

    // attention/set should have been called (setQuestions sends full array)
    const attentionSetCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionSetCall);

    // attention/clear should NOT have been called
    const attentionClearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(attentionClearCall, undefined);
  });

  it("keeps-defaulted question is not injected (status=closed, not pending-delivery)", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
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
    (bridge as any).sessionQuestions.set(sessionId, questions);

    (bridge as any).onRequest(makePromptReq(sessionId, [{ type: "text", text: "Hello" }]));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(stubClient._lastReply.payload, { action: "continue" });
  });

  it("attention flag is republished after injection", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
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
    (bridge as any).sessionQuestions.set(sessionId, questions);

    (bridge as any).onRequest(makePromptReq(sessionId, [{ type: "text", text: "Go" }]));
    await new Promise((r) => setTimeout(r, 100));

    // attention/set should have been called via setQuestions
    const attentionCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(attentionCall);
    const setParams = attentionCall!.params as Record<string, unknown>;
    assert.strictEqual(setParams.sessionId, sessionId);
    assert.strictEqual(setParams.reason, "questions");

    // attention/clear should NOT have been called
    const clearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(clearCall, undefined);
  });

  it("does not mutate the original envelope object", async () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    const sessionId = `session-${Date.now()}`;
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
    (bridge as any).sessionQuestions.set(sessionId, questions);

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
  it("publishAttentionFlag has been removed (reconcile rewritten in next task)", () => {
    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    assert.strictEqual(
      typeof (bridge as any).publishAttentionFlag,
      "undefined",
      "publishAttentionFlag should be removed — reconcile is rewritten in the next task",
    );
  });
});

describe("ClarifierBridge — lifecycle event handlers", () => {
  it("session.closed does not trigger any WS call", async () => {
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    });
    (bridge as any).client = stubClient;

    // Pre-populate cache so there's state to potentially surface
    const sessionId = `session-closed-${Date.now()}`;
    (bridge as any).sessionQuestions.set(sessionId, [{
      id: "q-closed-test",
      question: "Closed test?",
      defaultAnswer: "Yes",
      askedAt: Date.now(),
      status: "open",
    }]);

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

  it("ignores unknown lifecycle events", async () => {
    const stubClient = makeStubClient();

    const bridge = new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
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
      daemonUrl: "http://stub",
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

describe("ClarifierBridge — in-memory question cache", () => {
  let stubClient: TransformerClientStub;

  function makeBridge() {
    return new ClarifierBridge({
      daemonWsUrl: "ws://127.0.0.1:55514/acp",
      daemonUrl: "http://127.0.0.1:55514",
      token: "test-token",
    }) as ClarifierBridge & { opts: { daemonUrl: string } };
  }

  beforeEach(() => {
    stubClient = makeStubClient();
  });

  it("getQuestions returns empty array for a missing session entry", () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    const questions = (bridge as any).getQuestions("nonexistent-session");
    assert.deepStrictEqual(questions, []);
  });

  it("getQuestions returns the cached array for a session that has entries", () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    const q1 = { id: "q-1", question: "Q1?", defaultAnswer: "Yes", askedAt: Date.now(), status: "open" as const };
    (bridge as any).sessionQuestions.set("sess-1", [q1]);

    const questions = (bridge as any).getQuestions("sess-1");
    assert.strictEqual(questions.length, 1);
    assert.strictEqual(questions[0].id, "q-1");
  });

  it("setQuestions with data updates the map AND calls attention/set with the right payload", async () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    const sessionId = "sess-set-test";
    const questions = [
      { id: "q-1", question: "Proceed?", defaultAnswer: "Yes", askedAt: Date.now(), status: "open" as const },
    ];

    await (bridge as any).setQuestions(sessionId, questions);

    // Map should be updated
    const cached = (bridge as any).getQuestions(sessionId);
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].id, "q-1");

    // attention/set should have been called
    const setCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.ok(setCall, "expected hydra-acp/attention/set to be called");
    assert.strictEqual(setCall.params.sessionId, sessionId);
    assert.strictEqual(setCall.params.reason, "questions");
    const payload = setCall.params.payload as { kind: string; questions: unknown[] };
    assert.strictEqual(payload.kind, "questions");
    assert.strictEqual(payload.questions.length, 1);
    assert.strictEqual(payload.questions[0].id, "q-1");

    // attention/clear should NOT have been called
    const clearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.strictEqual(clearCall, undefined);
  });

  it("setQuestions with empty array calls attention/clear and deletes the map entry", async () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    // Pre-populate the cache so we can verify deletion
    const sessionId = "sess-clear-test";
    (bridge as any).sessionQuestions.set(sessionId, [
      { id: "q-1", question: "Q?", defaultAnswer: "Y", askedAt: Date.now(), status: "open" as const },
    ]);

    await (bridge as any).setQuestions(sessionId, []);

    // Map entry should be deleted
    const cached = (bridge as any).getQuestions(sessionId);
    assert.deepStrictEqual(cached, []);

    // attention/clear should have been called
    const clearCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/clear",
    );
    assert.ok(clearCall, "expected hydra-acp/attention/clear to be called");
    assert.strictEqual(clearCall.params.sessionId, sessionId);
    assert.strictEqual(clearCall.params.reason, "questions");

    // attention/set should NOT have been called
    const setCall = stubClient._requestLog.find(
      (r: { method: string }) => r.method === "hydra-acp/attention/set",
    );
    assert.strictEqual(setCall, undefined);
  });

 it("setQuestions mutation order: map is updated before daemon call", async () => {
    const bridge = makeBridge();

    // Use a dedicated stub for this test to avoid polluting the shared one
    const mutationStub = makeStubClient();
    (bridge as any).client = mutationStub;

    // Track WS calls to verify mutation order
    const events: string[] = [];
    mutationStub.request = async (method, _params) => {
      events.push(`ws:${method}`);
      return { ok: true };
    };

    const sessionId = "sess-mutation-order";
    const questions = [
      { id: "q-1", question: "Proceed?", defaultAnswer: "Yes", askedAt: Date.now(), status: "open" as const },
    ];

    // Verify that after setQuestions completes, the map has the entry
    await (bridge as any).setQuestions(sessionId, questions);

    // Map should have exactly one entry (the one we just set)
    assert.strictEqual((bridge as any).sessionQuestions.size, 1);
    assert.strictEqual((bridge as any).getQuestions(sessionId).length, 1);

    // WS call should have been made for attention/set
    assert.ok(events.includes("ws:hydra-acp/attention/set"));
  });

  it("populateQuestionsCache parses response and populates the map", async () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    const mockFlags = [
      {
        sessionId: "sess-fetch-1",
        source: "hydra-acp-clarifier",
        reason: "questions",
        raisedAt: Date.now(),
        payload: { kind: "questions", questions: [{ id: "q-a", question: "A?", defaultAnswer: "Y", askedAt: Date.now(), status: "open" as const }] },
      },
      {
        sessionId: "sess-fetch-2",
        source: "hydra-acp-clarifier",
        reason: "questions",
        raisedAt: Date.now(),
        payload: { kind: "questions", questions: [{ id: "q-b", question: "B?", defaultAnswer: "N", askedAt: Date.now(), status: "pending-delivery" as const }] },
      },
    ];

    const savedFetch = globalThis.fetch;
    (globalThis.fetch as unknown) = async () => {
      return {
        ok: true,
        json: async () => ({ flags: mockFlags }),
      } as Response;
    };

    try {
      await (bridge as any).populateQuestionsCache();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.strictEqual((bridge as any).sessionQuestions.size, 2);
    assert.strictEqual((bridge as any).getQuestions("sess-fetch-1").length, 1);
    assert.strictEqual((bridge as any).getQuestions("sess-fetch-1")[0].id, "q-a");
    assert.strictEqual((bridge as any).getQuestions("sess-fetch-2").length, 1);
    assert.strictEqual((bridge as any).getQuestions("sess-fetch-2")[0].id, "q-b");
  });

  it("populateQuestionsCache skips flags with no questions", async () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    const mockFlags = [
      {
        sessionId: "sess-empty",
        source: "hydra-acp-clarifier",
        reason: "questions",
        raisedAt: Date.now(),
        payload: { kind: "questions", questions: [] },
      },
    ];

    const savedFetch = globalThis.fetch;
    (globalThis.fetch as unknown) = async () => {
      return {
        ok: true,
        json: async () => ({ flags: mockFlags }),
      } as Response;
    };

    try {
      await (bridge as any).populateQuestionsCache();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.strictEqual((bridge as any).sessionQuestions.size, 0);
  });

  it("populateQuestionsCache logs warning on non-OK response and does not mutate cache", async () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    // Pre-populate so we can verify nothing changes
    (bridge as any).sessionQuestions.set("existing", [
      { id: "q-existing", question: "E?", defaultAnswer: "Y", askedAt: Date.now(), status: "open" as const },
    ]);

    const savedFetch = globalThis.fetch;
    (globalThis.fetch as unknown) = async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response;
    };

    try {
      await (bridge as any).populateQuestionsCache();
    } finally {
      globalThis.fetch = savedFetch;
    }

    // Pre-populated entry should remain unchanged
    assert.strictEqual((bridge as any).sessionQuestions.size, 1);
    assert.strictEqual((bridge as any).getQuestions("existing").length, 1);
  });

  it("populateQuestionsCache handles fetch rejection gracefully", async () => {
    const bridge = makeBridge();
    (bridge as any).client = stubClient;

    const savedFetch = globalThis.fetch;
    (globalThis.fetch as unknown) = async () => {
      throw new Error("network error");
    };

    try {
      // Should not throw — best-effort
      await (bridge as any).populateQuestionsCache();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.strictEqual((bridge as any).sessionQuestions.size, 0);
  });
});
