# hydra-acp-clarifier

Deferred-question transformer extension for [hydra-acp](https://github.com/smagnuso/hydra-acp). Lets the agent record open assumptions it would like the user to confirm without blocking the turn. Surfaces them through hydra's [attention-flag](https://github.com/smagnuso/hydra-acp/blob/main/cli/PROTOCOL.md#attention) primitive so any client (TUI, browser, Slack bridge) can render them in its own way.

Runs as a daemon-managed *transformer* (not a client extension): it connects once, declares its intercepts via `transformer/initialize`, and sits inside the daemon's message pipeline for every live session.

## How it works

The clarifier reuses existing hydra-acp extension surfaces — it does not invent any new ACP protocol.

**Agent side** (registered via `hydra-acp/mcp_tools/register`):

- `note_question(question, default_answer, options?)` — agent records an assumption it would like the user to confirm. Returns `"noted"` immediately, does not block the turn.
- `list_open_questions()` — agent reads its own currently-open questions on this session (used after compaction to re-hydrate, or mid-long-turn to check for fresh answers).
- `dismiss_question(id)` — agent withdraws a question that has become moot.

**User side** (registered via `hydra-acp/commands/register`):

- `/hydra clarifier answer <id> <answer>` — record the user's answer for one question.
- `/hydra clarifier dismiss <id>` — drop one question without answering.
- `/hydra clarifier list` — print the open questions for the current session.

Clients invoke these via `hydra-acp/commands/invoke`; the daemon routes them to the clarifier.

**Persistence and signal:**

- Per-session question state lives in `~/.hydra-acp/sessions/<sessionId>/clarifier-questions.json`. Co-located with `meta.json` so removing a session also removes its questions.
- When any question on a session is open, the clarifier raises an attention flag via `hydra-acp/attention/set` with `reason: "questions"` and a payload carrying the full open-question list. Source is resolved server-side to `"hydra-acp-clarifier"`.
- When all questions are resolved (answered or dismissed), the clarifier calls `hydra-acp/attention/clear`.
- Clients learn of changes through the daemon's existing `hydra-acp/session/attention_updated` notification — no clarifier-specific broadcast.

**Answer injection:**

On the user's next `session/prompt`, the clarifier intercepts the outgoing prompt and prepends a block listing only **deviations** — questions whose user-answer differed from the agent's default. Kept-defaults are silently marked delivered (the conversation already reflects the agent's assumption). When no deviations exist, nothing is prepended.

**Startup reconcile:**

On boot, the clarifier scans `~/.hydra-acp/sessions/*/clarifier-questions.json`, re-publishes attention flags for sessions with open questions, and continues from where it left off.

## Install

From source (npm package not yet published):

```sh
git clone git@github.com:smagnuso/hydra-acp-clarifier.git ~/dev/hydra-acp-clarifier
cd ~/dev/hydra-acp-clarifier
npm install
npm run build
```

Register the transformer with hydra:

```sh
hydra-acp transformers add hydra-acp-clarifier \
  --command node \
  --args ~/dev/hydra-acp-clarifier/dist/index.js
```

That registers the transformer but does **not** wire it into sessions yet. Add it to `defaultTransformers` in `~/.hydra-acp/config.json`:

```json
{
  "transformers": {
    "hydra-acp-clarifier": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-clarifier/dist/index.js"]
    }
  },
  "defaultTransformers": ["hydra-acp-clarifier"]
}
```

Restart the daemon; new sessions will get the clarifier attached automatically.

## Status

**Pre-alpha scaffold.** The transformer process boots and connects to the daemon but does not yet implement the MCP tools, question persistence, attention-flag publishing, or prompt interception. See the [hydra-acp PROTOCOL.md](https://github.com/smagnuso/hydra-acp/blob/main/cli/PROTOCOL.md) for the attention-flag spec this extension targets.

## Question record shape (planned)

```ts
type Question = {
  id: string;
  question: string;
  defaultAnswer: string;
  options?: string[];          // suggested answers; free-text when absent
  askedAt: number;             // epoch ms
  askedDuringTurn?: string;
  status: "open" | "pending-delivery" | "closed";
  userAnswer?: string;         // present once user has engaged
  deviated?: boolean;          // userAnswer !== defaultAnswer
  closureReason?: "default-accepted" | "deviation-delivered" | "dismissed";
};
```

## License

MIT
