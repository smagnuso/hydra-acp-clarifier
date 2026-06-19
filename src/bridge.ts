import { readdir } from "node:fs/promises";
import { TransformerClient } from "./acp/transformer.js";
import type { JsonRpcRequest, JsonRpcNotification, TransformerSessionEvent } from "./acp/protocol.js";
import { logger } from "./util/log.js";
import { CLARIFIER_MCP_INSTRUCTIONS, CLARIFIER_MCP_TOOLS } from "./mcp-tools.js";
import { loadQuestions, saveQuestions } from "./store.js";
import { newQuestion, type Question } from "./question.js";
import { sessionsDir } from "./paths.js";

const log = logger("bridge");

// The set of intercepts the clarifier declares to the daemon. Kept in one
// place so the README, the router, and the lifecycle reconcile pass stay
// in agreement.
//
//   request:session/prompt            — prepend deviation answers to outgoing prompts
//   lifecycle:session.opened          — load the session's persisted questions
//   lifecycle:session.closed          — drop in-memory state for the session
//   request:hydra-acp/question/answer  — record user answer to an open question
//   request:hydra-acp/question/dismiss — dismiss a question (user or agent)
//   request:hydra-acp/question/list    — list open + pending-delivery questions
export const CLARIFIER_INTERCEPTS = [
  "request:session/prompt",
  "lifecycle:session.opened",
  "lifecycle:session.closed",
  "request:hydra-acp/question/answer",
  "request:hydra-acp/question/dismiss",
  "request:hydra-acp/question/list",
];

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
}

// One bridge per clarifier process. Owns the WS connection to the daemon
// and routes intercepts to the question-store. Mirrors BudgeterBridge.
export class ClarifierBridge {
  private readonly client: TransformerClient;
  private stopped = false;

  constructor(private readonly opts: BridgeOptions) {
    this.client = new TransformerClient({
      daemonWsUrl: opts.daemonWsUrl,
      token: opts.token,
      intercepts: CLARIFIER_INTERCEPTS,
    });
  }

  start(): void {
    this.client.on("open", () => this.onOpen());
    this.client.on("request", (req) => this.onRequest(req));
    this.client.on("notification", (note) => this.onNotification(note));
    this.client.on("close", ({ hadError }) => {
      if (!this.stopped) {
        log.warn(`client disconnected unexpectedly (hadError=${hadError})`);
      }
    });
    this.client.start();
    log.info(`clarifier bridge started`);
  }

  private onOpen(): void {
    log.info("clarifier connected to daemon");
    this.registerMcpTools();
    this.registerCommands();
    this.reconcile();
  }

  private async registerMcpTools(): Promise<void> {
    try {
      const result = await this.client.request<{ ok: boolean; registered: number }>(
        "hydra-acp/mcp_tools/register",
        {
          instructions: CLARIFIER_MCP_INSTRUCTIONS,
          tools: CLARIFIER_MCP_TOOLS,
        },
      );
      log.info(
        `registered ${result.registered ?? CLARIFIER_MCP_TOOLS.length} MCP tool(s): ${CLARIFIER_MCP_TOOLS.map((t) => t.name).join(", ")}`,
      );
    } catch (err) {
      log.error(`mcp_tools/register failed: ${(err as Error).message}`);
    }
  }

  private registerCommands(): void {
    // Placeholder — actual command registration in a later task.
    log.info("registering slash commands (placeholder)");
  }

  private async reconcile(): Promise<void> {
    try {
      const dirs = await readdir(sessionsDir(), { withFileTypes: true });
      let republishedCount = 0;
      const errors: string[] = [];

      for (const entry of dirs) {
        if (!entry.isDirectory()) continue;
        try {
          const questions = await loadQuestions(entry.name);
          // No questions file (or empty) → nothing for clarifier to
          // reconcile. Skip without calling attention/clear, which would
          // be wasteful on installs with many sessions.
          if (questions.length === 0) {
            continue;
          }
          const hasActive = questions.some(
            (q) => q.status === "open" || q.status === "pending-delivery",
          );
          // Always call publishAttentionFlag when a questions file
          // exists: hasActive → set; !hasActive → clear (defensive
          // cleanup of any stale flag left by a prior crash/restart).
          await this.publishAttentionFlag(entry.name);
          if (hasActive) {
            republishedCount++;
          }
        } catch (err) {
          errors.push(`session ${entry.name}: ${(err as Error).message}`);
        }
      }

      log.info(
        `clarifier reconcile: republished ${republishedCount} attention flags across ${dirs.filter((e) => e.isDirectory()).length} sessions`,
      );

      if (errors.length > 0) {
        log.warn(`clarifier reconcile: encountered errors for ${errors.length} session(s): ${errors.join("; ")}`);
      }
    } catch (err) {
      log.error(`clarifier reconcile failed: ${(err as Error).message}`);
    }
  }

  private onRequest(req: JsonRpcRequest): void {
    if (req.method === "hydra-acp/transformer/message") {
      this.handleTransformerMessage(req);
      return;
    }
    if (req.method === "hydra-acp/mcp_tools/invoke") {
      this.handleMcpInvoke(req);
      return;
    }
    // Unknown method — reply with method-not-found error.
    log.warn(`unexpected request method: ${req.method}`);
    this.client.replyError(req.id, -32601, "Method not found");
  }

  private handleTransformerMessage(req: JsonRpcRequest): void {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const phase = typeof params.phase === "string" ? params.phase : "";
    const method = typeof params.method === "string" ? params.method : "";

    if (!sessionId || !phase || !method) {
      this.client.reply(req.id, { action: "continue" });
      return;
    }

    const dispatchKey = `${phase}:${method}`;

    switch (dispatchKey) {
      case "request:hydra-acp/question/answer":
        this.handleAnswer(req);
        break;
      case "request:hydra-acp/question/dismiss":
        this.handleDismiss(req);
        break;
      case "request:hydra-acp/question/list":
        this.handleList(req);
        break;
      case "request:session/prompt":
        this.handlePromptIntercept(req);
        break;
      default:
        log.debug(`unknown transformer dispatch: ${dispatchKey}`);
        this.client.replyError(req.id, -32601, "Method not found");
    }
  }

  private async handleAnswer(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const envelope = (params.envelope ?? {}) as Record<string, unknown>;
    const questionId = typeof envelope.questionId === "string" ? envelope.questionId : "";
    const answer = typeof envelope.answer === "string" ? envelope.answer : "";

    if (!sessionId || !questionId || !answer) {
      this.client.replyError(req.id, -32602, "InvalidParams: sessionId, questionId, and answer are required");
      return;
    }

    const questions = await loadQuestions(sessionId);
    const idx = questions.findIndex((q) => q.id === questionId);
    if (idx === -1) {
      this.client.replyError(req.id, -32602, `InvalidParams: no question found with id '${questionId}'`);
      return;
    }

    const existing = questions[idx]!;
    if (existing.status === "closed") {
      this.client.replyError(req.id, -32602, `InvalidParams: question '${questionId}' is already closed (${existing.closureReason ?? "unknown reason"})`);
      return;
    }
    const deviated = answer !== existing.defaultAnswer;
    questions[idx] = {
      ...existing,
      userAnswer: answer,
      deviated,
      status: deviated ? "pending-delivery" : "closed",
      closureReason: deviated ? undefined : "default-accepted",
    };
    await saveQuestions(sessionId, questions);

    this.client.reply(req.id, { action: "stop", payload: { ok: true } });
    void this.publishAttentionFlag(sessionId);
    void this.emitQuestionAnswered(sessionId, questionId, answer, deviated).catch((err) =>
      log.error(`failed to emit question/answered: ${(err as Error).message}`),
    );
  }

  private async handleDismiss(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const envelope = (params.envelope ?? {}) as Record<string, unknown>;
    const questionId = typeof envelope.questionId === "string" ? envelope.questionId : "";

    if (!sessionId || !questionId) {
      this.client.replyError(req.id, -32602, "InvalidParams: sessionId and questionId are required");
      return;
    }

    const questions = await loadQuestions(sessionId);
    const idx = questions.findIndex((q) => q.id === questionId);
    if (idx === -1) {
      this.client.replyError(req.id, -32602, `InvalidParams: no question found with id '${questionId}'`);
      return;
    }

    const existing = questions[idx]!;
    if (existing.status === "closed") {
      this.client.reply(req.id, { action: "stop", payload: { ok: true } });
      return;
    }
    questions[idx] = {
      ...existing,
      status: "closed",
      closureReason: "dismissed",
    };
    await saveQuestions(sessionId, questions);

    this.client.reply(req.id, { action: "stop", payload: { ok: true } });
    void this.publishAttentionFlag(sessionId);
    void this.emitQuestionDismissed(sessionId, questionId, "user").catch((err) =>
      log.error(`failed to emit question/dismissed: ${(err as Error).message}`),
    );
  }

  private async handleList(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!sessionId) {
      this.client.replyError(req.id, -32602, "InvalidParams: sessionId is required");
      return;
    }

    const questions = await loadQuestions(sessionId);
    const active = questions.filter(
      (q) => q.status === "open" || q.status === "pending-delivery",
    );

    this.client.reply(req.id, { action: "stop", payload: { questions: active } });
  }

  private async handlePromptIntercept(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const envelope = (params.envelope ?? {}) as Record<string, unknown>;

    if (!sessionId) {
      this.client.reply(req.id, { action: "continue" });
      return;
    }

    const questions = await loadQuestions(sessionId);
    const toInject = questions.filter(
      (q) => q.status === "pending-delivery" && q.deviated === true,
    );

    if (toInject.length === 0) {
      this.client.reply(req.id, { action: "continue" });
      return;
    }

    const deviationBlock =
      "[Answers to your earlier questions:]\n" +
      toInject.map((q) => `- Q: "${q.question}" → ${q.userAnswer}`).join("\n");

    const originalPrompt = Array.isArray(envelope.prompt)
      ? envelope.prompt
      : [];
    const newPrompt = [
      { type: "text", text: deviationBlock + "\n\n" },
      ...originalPrompt,
    ];
    const rewrittenEnvelope = { ...envelope, prompt: newPrompt };

    for (const q of toInject) {
      const idx = questions.findIndex((x) => x.id === q.id);
      if (idx !== -1) {
        questions[idx] = {
          ...questions[idx]!,
          status: "closed",
          closureReason: "deviation-delivered",
        };
      }
    }

    try {
      await saveQuestions(sessionId, questions);
    } catch (err) {
      log.error(`save failed during prompt intercept: ${(err as Error).message}`);
    }

    void this.publishAttentionFlag(sessionId).catch((err) =>
      log.error(`publishAttentionFlag after inject failed: ${(err as Error).message}`),
    );

    this.client.reply(req.id, { action: "continue", payload: rewrittenEnvelope });
  }

  private async handleMcpInvoke(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const method = typeof params.method === "string" ? params.method : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

    if (!sessionId) {
      this.client.reply(req.id, {
        content: [{ type: "text", text: "internal: missing sessionId on mcp_tools/invoke" }],
        isError: true,
      });
      return;
    }

    switch (method) {
      case "note_question":
        await this.handleNoteQuestion(req.id, sessionId, params);
        break;
      case "list_open_questions":
        await this.handleListOpenQuestions(req.id, sessionId);
        break;
      case "dismiss_question":
        await this.handleDismissQuestion(req.id, sessionId, params);
        break;
      default:
        log.warn(`unknown MCP tool method: ${method}`);
        this.client.reply(req.id, {
          content: [{ type: "text", text: `unknown clarifier tool: ${method}` }],
          isError: true,
        });
    }
  }

  private async handleNoteQuestion(
    reqId: number | string,
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const question = typeof params.question === "string" ? params.question : "";
    const defaultAnswer = typeof params.default_answer === "string" ? params.default_answer : "";
    const options = Array.isArray(params.options)
      ? (params.options as string[])
      : undefined;

    if (!question || !defaultAnswer) {
      this.client.reply(reqId, {
        content: [{ type: "text", text: "note_question requires 'question' and 'default_answer'" }],
        isError: true,
      });
      return;
    }

    let questions = await loadQuestions(sessionId);
    const newQ = newQuestion({ question, defaultAnswer, options });
    questions.push(newQ);
    await saveQuestions(sessionId, questions);
    this.client.reply(reqId, {
      content: [{ type: "text", text: "noted" }],
    });
    void this.publishAttentionFlag(sessionId);
    void this.emitQuestionAsked(sessionId, newQ).catch((err) =>
      log.error(`failed to emit question/asked: ${(err as Error).message}`),
    );
  }

  private async handleListOpenQuestions(
    reqId: number | string,
    sessionId: string,
  ): Promise<void> {
    const questions = await loadQuestions(sessionId);
    const filtered = questions.filter(
      (q) => q.status === "open" || q.status === "pending-delivery",
    );
    this.client.reply(reqId, {
      content: [{ type: "text", text: JSON.stringify(filtered) }],
    });
  }

  private async handleDismissQuestion(
    reqId: number | string,
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof params.id === "string" ? params.id : "";

    if (!id) {
      this.client.reply(reqId, {
        content: [{ type: "text", text: "dismiss_question requires 'id'" }],
        isError: true,
      });
      return;
    }

    const questions = await loadQuestions(sessionId);
    const idx = questions.findIndex((q) => q.id === id);
    if (idx === -1) {
      this.client.reply(reqId, {
        content: [{ type: "text", text: `dismiss_question: no question found with id '${id}'` }],
        isError: true,
      });
      return;
    }

    const existing = questions[idx]!;
    if (existing.status === "closed") {
      this.client.reply(reqId, {
        content: [{ type: "text", text: "already closed" }],
      });
      return;
    }
    questions[idx] = {
      ...existing,
      status: "closed",
      closureReason: "dismissed",
    };
    await saveQuestions(sessionId, questions);
    this.client.reply(reqId, {
      content: [{ type: "text", text: "dismissed" }],
    });
    void this.publishAttentionFlag(sessionId);
    void this.emitQuestionDismissed(sessionId, id, "agent").catch((err) =>
      log.error(`failed to emit question/dismissed: ${(err as Error).message}`),
    );
  }

  private async emitQuestionAsked(
    sessionId: string,
    question: Question,
  ): Promise<void> {
    await this.client.request("hydra-acp/message/emit", {
      sessionId,
      method: "hydra-acp/question/asked",
      envelope: { sessionId, question },
      route: "daemon",
    });
  }

  private async emitQuestionAnswered(
    sessionId: string,
    questionId: string,
    userAnswer: string,
    deviated: boolean,
  ): Promise<void> {
    await this.client.request("hydra-acp/message/emit", {
      sessionId,
      method: "hydra-acp/question/answered",
      envelope: { sessionId, questionId, userAnswer, deviated },
      route: "daemon",
    });
  }

  private async emitQuestionDismissed(
    sessionId: string,
    questionId: string,
    by: "user" | "agent",
  ): Promise<void> {
    await this.client.request("hydra-acp/message/emit", {
      sessionId,
      method: "hydra-acp/question/dismissed",
      envelope: { sessionId, questionId, by },
      route: "daemon",
    });
  }

 private async publishAttentionFlag(sessionId: string): Promise<void> {
    try {
      const questions = await loadQuestions(sessionId);
      const active = questions.filter(
        (q) => q.status === "open" || q.status === "pending-delivery",
      );
      if (active.length > 0) {
        await this.client.request("hydra-acp/attention/set", {
          sessionId,
          reason: "questions",
          payload: { kind: "questions", questions: active },
        });
      } else {
        await this.client.request("hydra-acp/attention/clear", {
          sessionId,
          reason: "questions",
        });
      }
    } catch (err) {
      log.warn(`publishAttentionFlag failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  private onNotification(note: JsonRpcNotification): void {
    if (note.method !== "hydra-acp/transformer/session_event") {
      return;
    }
    const params = (note.params ?? {}) as Record<string, unknown>;
    const event = typeof params.event === "string" ? params.event : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!event || !sessionId) {
      return;
    }
    switch (event) {
      case "session.opened":
        void this.publishAttentionFlag(sessionId).catch((err) =>
          log.error(`publishAttentionFlag on session.opened failed: ${(err as Error).message}`),
        );
        break;
      case "session.closed":
        log.debug(`session ${sessionId} closed`);
        break;
      default:
        log.debug(`unknown lifecycle event: ${event}`);
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.client.stop();
  }
}
