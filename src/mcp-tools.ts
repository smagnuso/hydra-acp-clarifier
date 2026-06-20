// MCP tool specs the clarifier advertises to agents via
// hydra-acp/mcp_tools/register. Agents see these as native tools they
// can call from any conversational turn to record deferred questions,
// list them, or dismiss them — keeping the conversation flowing without
// blocking on user input.

export const CLARIFIER_MCP_INSTRUCTIONS = `\
Tools for surfacing the deferred decisions you make while working — \
the small judgment calls a thoughtful collaborator would normally \
just resolve silently, but where the user might have preferred \
otherwise.

Why this matters:
  Every non-trivial task contains decisions you have to make to keep \
  moving — naming, file layout, error semantics, backoff strategy, \
  preserving public APIs, when to refactor adjacent code, etc. You \
  pick a default and proceed. If your default differs from what the \
  user would have chosen, they only discover that AFTER reading your \
  output — when redirecting your work is expensive. note_question \
  surfaces those decisions cheaply, while they're still in flight, \
  without blocking your turn.

The non-blocking property is the whole point:
  You DO NOT wait for the user. You pick a sensible default, call \
  note_question to record the decision (with the default + any \
  reasonable alternatives), and continue working. The user reviews \
  your noted questions when convenient; if they disagree with a \
  default, their answer is injected into your next turn as a \
  directive. If they don't push back, your default stands.

When to call note_question:
  - You're refactoring and decide whether to preserve existing public \
    method names. Default: preserve. → note it.
  - You're adding retries and pick exponential backoff with 3 attempts. \
    → note it.
  - You're migrating storage and decide to leave old files on disk \
    rather than delete. → note it.
  - You're naming a new module and picked one of three plausible names. \
    → note it.
  - You're touching adjacent code that wasn't strictly in scope but \
    seemed worth tidying. → note it.

When NOT to call note_question:
  - The decision is required before you can take ANY action ("which \
    of these three files do you mean?"). Ask the user directly in \
    your reply — note_question is for deferred decisions, not \
    blocking ones.
  - The decision has only one defensible answer (no real choice to \
    surface).
  - You've already noted a substantively similar question this turn.

Use sparingly but not stingily — a turn that surfaces 1–3 deferred \
decisions on a non-trivial task is the sweet spot. Zero on a \
refactor with real judgment calls usually means you silently \
assumed something the user might have wanted to weigh in on; five \
on the same task usually means you flagged trivia.

Other tools:
  - list_open_questions returns the session's pending questions \
    (useful after compaction or to check whether the user has \
    answered).
  - dismiss_question closes a question that's no longer relevant \
    (e.g. you've since learned the answer from context).\
`;

export interface ClarifierMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CLARIFIER_MCP_TOOLS: ClarifierMcpTool[] = [
  {
    name: "note_question",
    description:
      'Surface a deferred decision you are making mid-task — pick a sensible default and call this to flag the choice for the user, then continue working without waiting. Use whenever you make a judgment call the user might have preferred otherwise (naming, error semantics, scope creep, refactor style, retry policy, etc.); the user reviews noted questions when convenient and any disagreement is injected into your next turn as a directive. If they say nothing, your default stands. Do NOT use this for blocking questions where you need an answer before acting at all — ask directly in your reply for those. Returns "noted" immediately; generates a question id internally.',
    inputSchema: {
      type: "object",
      required: ["question", "default_answer"],
      properties: {
        question: {
          type: "string",
          description:
            "The human-readable question to ask the user.",
        },
        default_answer: {
          type: "string",
          description:
            "Your assumption — what you will proceed with if the user does not respond.",
        },
        options: {
          type: "array",
          description:
            "Optional suggested answers. If provided, the user may pick one; otherwise they can type a free-text answer.",
          items: {
            type: "string",
          },
        },
      },
    },
  },
  {
    name: "list_open_questions",
    description:
      'Return the session\'s current open and pending-delivery questions as JSON. Useful for re-hydrating after compaction or checking for fresh user answers mid-turn.',
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "dismiss_question",
    description:
      'Mark a question as dismissed (the agent self-cleaning). Use when a question is no longer relevant. Pass the question id returned by note_question. Returns "dismissed" on success, or an error if the id is not found.',
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description:
            "The question id to dismiss (e.g. 'a1b2c3d4-...').",
        },
      },
    },
  },
];
