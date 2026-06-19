// MCP tool specs the clarifier advertises to agents via
// hydra-acp/mcp_tools/register. Agents see these as native tools they
// can call from any conversational turn to record deferred questions,
// list them, or dismiss them — keeping the conversation flowing without
// blocking on user input.

export const CLARIFIER_MCP_INSTRUCTIONS = `\
Tools for recording and managing deferred questions during a \
conversational turn. Use these when you want to note assumptions, \
clarify requirements, or flag decisions that need user input without \
blocking the current turn.

When to use:
  - Use note_question when you make an assumption you'd like the user \
    to confirm but can proceed without; do not block the turn waiting.
  - Use list_open_questions to check what questions are still open \
    (especially after compaction or mid-turn).
  - Use dismiss_question when a question is no longer relevant and \
    you want to clean it up.

Workflow:
  1. When you make an assumption worth flagging, call note_question \
     with the question text, your default answer, and optional \
     suggested options. The turn continues immediately.
  2. If you need to check what's still pending, call list_open_questions.
  3. Once a question has been answered or is no longer relevant, \
     dismiss it with dismiss_question.\
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
      'Record a deferred question for the user. Use when you make an assumption you would like confirmed but can proceed without — call this and keep going, do not block the turn waiting for an answer. Returns "noted" immediately. Generates a question id internally.',
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
