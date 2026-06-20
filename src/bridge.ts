import { readdir, readFile, unlink } from "node:fs/promises";
import { TransformerClient } from "./acp/transformer.js";
import type { JsonRpcRequest, JsonRpcNotification, TransformerSessionEvent } from "./acp/protocol.js";
import { logger } from "./util/log.js";
import { CLARIFIER_MCP_INSTRUCTIONS, CLARIFIER_MCP_TOOLS } from "./mcp-tools.js";
import { newQuestion, QuestionArraySchema, type Question } from "./question.js";
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
  daemonUrl: string;
  token: string;
}

// Poll interval for retrying transformer/attach against sessions that
// had open questions at reconcile time but were cold (SessionNotFound).
// When the user reopens such a session in the TUI, the next poll succeeds
// and the session's chain picks up clarifier so /question/list, /answer,
// and /dismiss route correctly. Modeled after planner's runActivationTick.
const ACTIVATION_POLL_MS = 5_000;

// One bridge per clarifier process. Owns the WS connection to the daemon
// and routes intercepts to the question-store. Mirrors BudgeterBridge.
export class ClarifierBridge {
  private readonly client: TransformerClient;
  private stopped = false;
  // Sessions we believe we've attached to (via hydra-acp/transformer/attach)
  // during this process lifetime. Best-effort cache: if the daemon dropped
  // us from a chain for any reason, this is wrong but harmless — re-attach
  // is idempotent on the daemon side and we'll re-add on the next MCP call.
  private readonly attachedSessions = new Set<string>();
  // Sessions with open questions whose first attach attempt failed because
  // the session was cold. Polled periodically until attach succeeds.
  private readonly pendingAttach = new Set<string>();
  // In-flight attach promises keyed by sessionId — dedupes concurrent
  // ensureAttached calls (e.g. when several MCP tool calls land on the
  // same session in quick succession).
  private readonly inFlightAttach = new Map<string, Promise<void>>();
  private activationTimer: NodeJS.Timeout | undefined;
  private readonly sessionQuestions = new Map<string, Question[]>();

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
    // EventEmitter throws an unhandled-error exception (and crashes the
    // process) if `error` has no listener. Always attach one; the daemon
    // will restart us if we exit, so logging-and-continuing is the right
    // default. Without this, any WS error during handshake (e.g. a
    // transient ECONNRESET, invalid token, daemon not yet up) crashes
    // the process and produces a restart loop.
    this.client.on("error", (err) => {
      log.warn(`client error: ${err.message}`);
    });
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

  // Startup recovery. Two stages:
  //
  //   1. One-shot file migration: scan ~/.hydra-acp/sessions/*/clarifier-questions.json
  //      from prior persistence layout. For each, push to the daemon's
  //      attention flag and delete the file. Idempotent — after first run,
  //      no files exist.
  //
  //   2. Daemon-side load: GET /v1/sessions/attention?source=hydra-acp-clarifier
  //      to populate the in-memory cache with all our existing flags
  //      (including ones we just migrated in stage 1).
  //
  // Finally, for each session with active questions, schedule self-attach
  // so client→clarifier wire calls route through the session's chain.
  private async reconcile(): Promise<void> {
    let migratedFiles = 0;
    try {
      const dirs = await readdir(sessionsDir(), { withFileTypes: true });
      for (const entry of dirs) {
        if (!entry.isDirectory()) continue;
        const filePath = `${sessionsDir()}/${entry.name}/clarifier-questions.json`;
        try {
          const raw = await readFile(filePath, "utf-8");
          const parsed = JSON.parse(raw);
          const result = QuestionArraySchema.safeParse(parsed);
          if (!result.success) {
            log.warn(`clarifier migrate: parse failed for ${filePath}: ${result.error.message}`);
            continue;
          }
          if (result.data.length === 0) {
            await unlink(filePath).catch(() => undefined);
            continue;
          }
          // Push to daemon via setQuestions (handles attention/set
          // and updates in-memory cache as a side-effect).
          await this.setQuestions(entry.name, result.data);
          await unlink(filePath);
          migratedFiles++;
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code === "ENOENT") {
            // No file for this session — normal post-migration state.
            continue;
          }
          log.warn(`clarifier migrate: error on ${entry.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "ENOENT") {
        log.warn(`clarifier migrate: scan failed: ${(err as Error).message}`);
      }
    }

    // Stage 2: populate the in-memory cache from the daemon's stored flags.
    // After the migration above, all our state is in the daemon, so this
    // single fetch is the canonical "what does the clarifier own" load.
    try {
      await this.populateQuestionsCache();
    } catch (err) {
      log.warn(`clarifier reconcile: populate failed: ${(err as Error).message}`);
    }

    // Schedule self-attach for every session with active questions so
    // client→clarifier wire calls (question/list / answer / dismiss)
    // route through the session's transformer chain. Cold sessions go
    // into the polling loop and attach when they wake up.
    let activeSessions = 0;
    for (const [sessionId, questions] of this.sessionQuestions) {
      const hasActive = questions.some(
        (q) => q.status === "open" || q.status === "pending-delivery",
      );
      if (hasActive) {
        activeSessions++;
        void this.ensureAttached(sessionId);
      }
    }

    log.info(
      `clarifier reconcile: migrated ${migratedFiles} file(s), restored ${this.sessionQuestions.size} session(s), ${activeSessions} active`,
    );
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
    log.info(`transformer/message: ${dispatchKey} session=${sessionId}`);

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

    const questions = this.getQuestions(sessionId);
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
    await this.setQuestions(sessionId, questions);

    this.client.reply(req.id, { action: "stop", payload: { ok: true } });
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

    const questions = this.getQuestions(sessionId);
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
    await this.setQuestions(sessionId, questions);

    this.client.reply(req.id, { action: "stop", payload: { ok: true } });
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

    const questions = this.getQuestions(sessionId);
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
      log.debug("prompt-intercept: no sessionId, passing through");
      this.client.reply(req.id, { action: "continue" });
      return;
    }

    const questions = this.getQuestions(sessionId);
    const toInject = questions.filter(
      (q) => q.status === "pending-delivery" && q.deviated === true,
    );

    log.debug(
      `prompt-intercept: session=${sessionId} cached=${questions.length} toInject=${toInject.length}`,
    );

    if (toInject.length === 0) {
      this.client.reply(req.id, { action: "continue" });
      return;
    }

    // Framing matters: bracketed meta-blocks ("[Answers to questions: ...]")
    // get parsed as scaffolding the model is free to ignore. Phrasing the
    // answers as if the user typed them — first person, declarative, no
    // brackets — gets the agent to actually act on them. The follow-up
    // text becomes a "P.S." style continuation of the user's voice.
    const lines = toInject
      .map(
        (q) =>
          `For my earlier question "${q.question}", my answer is: ${q.userAnswer}.`,
      )
      .join("\n");
    const deviationBlock = `${lines}\n\nWith that, here is what I want next:\n`;

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

    await this.setQuestions(sessionId, questions);

    this.client.reply(req.id, { action: "continue", payload: rewrittenEnvelope });
  }

  private async handleMcpInvoke(req: JsonRpcRequest): Promise<void> {
    const params = (req.params ?? {}) as {
      server?: unknown;
      tool?: unknown;
      args?: unknown;
      sessionId?: unknown;
    };
    const tool = typeof params.tool === "string" ? params.tool : "";
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const args = (params.args && typeof params.args === "object"
      ? (params.args as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    if (!sessionId) {
      this.client.reply(req.id, {
        content: [{ type: "text", text: "internal: missing sessionId on mcp_tools/invoke" }],
        isError: true,
      });
      return;
    }

    switch (tool) {
      case "note_question":
        await this.handleNoteQuestion(req.id, sessionId, args);
        break;
      case "list_open_questions":
        await this.handleListOpenQuestions(req.id, sessionId);
        break;
      case "dismiss_question":
        await this.handleDismissQuestion(req.id, sessionId, args);
        break;
      default:
        log.warn(`unknown MCP tool: '${tool}'`);
        this.client.reply(req.id, {
          content: [{ type: "text", text: `unknown clarifier tool: '${tool}'` }],
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

    let questions = this.getQuestions(sessionId);
    const newQ = newQuestion({ question, defaultAnswer, options });
    questions.push(newQ);
    await this.setQuestions(sessionId, questions);
    this.client.reply(reqId, {
      content: [{ type: "text", text: "noted" }],
    });
    // Self-attach so subsequent client→clarifier wire calls (question/list
    // /answer/dismiss) route through this session's chain. The MCP tool
    // call itself doesn't need chain membership — it arrived via the HTTP
    // /mcp/hydra-acp-clarifier route — but the answer-back wire path does.
    void this.ensureAttached(sessionId);
    void this.emitQuestionAsked(sessionId, newQ).catch((err) =>
      log.error(`failed to emit question/asked: ${(err as Error).message}`),
    );
  }

  private async handleListOpenQuestions(
    reqId: number | string,
    sessionId: string,
  ): Promise<void> {
    const questions = this.getQuestions(sessionId);
    const filtered = questions.filter(
      (q) => q.status === "open" || q.status === "pending-delivery",
    );
    this.client.reply(reqId, {
      content: [{ type: "text", text: JSON.stringify(filtered) }],
    });
    void this.ensureAttached(sessionId);
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

    const questions = this.getQuestions(sessionId);
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
    await this.setQuestions(sessionId, questions);
    this.client.reply(reqId, {
      content: [{ type: "text", text: "dismissed" }],
    });
    void this.ensureAttached(sessionId);
    void this.emitQuestionDismissed(sessionId, id, "agent").catch((err) =>
      log.error(`failed to emit question/dismissed: ${(err as Error).message}`),
    );
  }

  // Push an ephemeral session/update notification to attached clients of
  // the target session. The daemon's "client_broadcast" route fans the
  // envelope out as a `session/update` notification — TUI handlers react
  // (e.g. show a banner when a new question is asked).
  private async emitQuestionAsked(
    sessionId: string,
    question: Question,
  ): Promise<void> {
    await this.client.request("hydra-acp/message/emit", {
      sessionId,
      envelope: { sessionUpdate: "clarifier_question_asked", question },
      route: "client_broadcast",
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
      envelope: {
        sessionUpdate: "clarifier_question_answered",
        questionId,
        userAnswer,
        deviated,
      },
      route: "client_broadcast",
    });
  }

  private async emitQuestionDismissed(
    sessionId: string,
    questionId: string,
    by: "user" | "agent",
  ): Promise<void> {
    await this.client.request("hydra-acp/message/emit", {
      sessionId,
      envelope: {
        sessionUpdate: "clarifier_question_dismissed",
        questionId,
        by,
      },
      route: "client_broadcast",
    });
  }

  // Self-attach to a session's transformer chain so client→clarifier wire
  // calls (hydra-acp/question/answer, /dismiss, /list) route to us. Idempotent
  // on both sides — we skip the wire call if we've already attached, and the
  // daemon's transformer/attach handler is itself idempotent. Failures from a
  // cold session (SessionNotFound) move the session to pendingAttach so the
  // polling loop retries when the user reopens it.
  private async ensureAttached(sessionId: string): Promise<void> {
    if (this.attachedSessions.has(sessionId)) {
      return;
    }
    const existing = this.inFlightAttach.get(sessionId);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      try {
        await this.client.request("hydra-acp/transformer/attach", { sessionId });
        this.attachedSessions.add(sessionId);
        this.pendingAttach.delete(sessionId);
        log.debug(`self-attached to ${sessionId}`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("not found")) {
          // Cold session — schedule a retry. Picked up the next time the
          // user opens the session in the TUI (which marks it live).
          this.pendingAttach.add(sessionId);
          this.ensureActivationTimer();
          log.debug(`self-attach deferred for ${sessionId} (cold)`);
        } else {
          log.warn(`transformer/attach failed for ${sessionId}: ${msg}`);
        }
      } finally {
        this.inFlightAttach.delete(sessionId);
      }
    })();
    this.inFlightAttach.set(sessionId, promise);
    return promise;
  }

  private ensureActivationTimer(): void {
    if (this.activationTimer || this.pendingAttach.size === 0 || this.stopped) {
      return;
    }
    this.activationTimer = setInterval(() => {
      void this.runActivationTick();
    }, ACTIVATION_POLL_MS);
    this.activationTimer.unref?.();
  }

  private async runActivationTick(): Promise<void> {
    if (this.pendingAttach.size === 0) {
      if (this.activationTimer) {
        clearInterval(this.activationTimer);
        this.activationTimer = undefined;
      }
      return;
    }
    // Snapshot so iteration isn't affected by ensureAttached's mutations.
    const sessions = Array.from(this.pendingAttach);
    await Promise.all(sessions.map((sid) => this.ensureAttached(sid)));
    if (this.pendingAttach.size === 0 && this.activationTimer) {
      clearInterval(this.activationTimer);
      this.activationTimer = undefined;
    }
  }

  getQuestions(sessionId: string): Question[] {
    return this.sessionQuestions.get(sessionId) ?? [];
  }

  async setQuestions(sessionId: string, questions: Question[]): Promise<void> {
    // Always keep the full list (including closed) in our in-process cache
    // so prompt-intercept can still find pending-delivery entries and so
    // we can answer list_open_questions consistently. But the daemon's
    // persisted attention payload only carries non-closed entries — closed
    // questions have no further surface to drive, and keeping them around
    // would just leave the picker badge stuck after everything's settled.
    this.sessionQuestions.set(sessionId, questions);
    const actionable = questions.filter((q) => q.status !== "closed");
    if (actionable.length > 0) {
      await this.client.request("hydra-acp/attention/set", {
        sessionId,
        reason: "questions",
        payload: { kind: "questions", questions: actionable },
      });
    } else {
      await this.client.request("hydra-acp/attention/clear", {
        sessionId,
        reason: "questions",
      });
    }
  }

  async populateQuestionsCache(): Promise<void> {
    try {
      const url = `${this.opts.daemonUrl}/v1/sessions/attention?source=hydra-acp-clarifier`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      });
      if (!res.ok) {
        log.warn(`populateQuestionsCache: HTTP ${res.status} from ${url}`);
        return;
      }
      const body = (await res.json()) as { flags?: unknown[] };
      const flags = Array.isArray(body.flags) ? body.flags : [];
      for (const flag of flags) {
        const flagObj = flag as Record<string, unknown>;
        const sessionId = typeof flagObj.sessionId === "string" ? flagObj.sessionId : "";
        const payload = flagObj.payload as Record<string, unknown> | undefined;
        const questions = Array.isArray(payload?.questions) ? payload.questions as Question[] : [];
        if (sessionId && questions.length > 0) {
          this.sessionQuestions.set(sessionId, questions);
        }
      }
      log.info(`populateQuestionsCache: loaded ${this.sessionQuestions.size} session(s)`);
    } catch (err) {
      log.warn(`populateQuestionsCache failed: ${(err as Error).message}`);
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
        log.debug(`session ${sessionId} opened`);
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
    if (this.activationTimer) {
      clearInterval(this.activationTimer);
      this.activationTimer = undefined;
    }
    this.client.stop();
  }
}
