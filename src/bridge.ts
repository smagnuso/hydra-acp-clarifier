import { TransformerClient } from "./acp/transformer.js";
import { logger } from "./util/log.js";

const log = logger("bridge");

// The set of intercepts the clarifier declares to the daemon. Kept in one
// place so the README, the router, and the lifecycle reconcile pass stay
// in agreement.
//
//   request:session/prompt    — prepend deviation answers to outgoing prompts
//                                before they reach the agent
//   lifecycle:session.opened   — load the session's persisted questions and
//                                set the attention flag if any are open
//   lifecycle:session.closed   — drop in-memory state for the session
const CLARIFIER_INTERCEPTS = [
  "request:session/prompt",
  "lifecycle:session.opened",
  "lifecycle:session.closed",
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
    // TODO: wire client events
    // - "request" → handle hydra-acp/transformer/message intercepts
    // - "notification" → handle hydra-acp/transformer/session_event
    // - "open" → register MCP tools, run startup reconcile
    // - "close" → flush state, exit if not stopped
    this.client.start();
    log.info(`clarifier bridge started`);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.client.stop();
  }
}
