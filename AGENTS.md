# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-clarifier` — deferred-question **transformer** for Hydra. Lets
the agent record open assumptions it would like the user to confirm
*without* blocking the turn. Surfaces them through hydra's attention-flag
primitive so any client (TUI, browser, Slack) can render them in its own
way.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md`, especially the attention-flag, MCP-tool registration,
and command-registration sections.

This is a **transformer**: it connects to the daemon, declares its
intercepts, and reuses **existing** hydra surfaces — it does *not* invent
new ACP protocol. Specifically it uses:

- `hydra-acp/mcp_tools/register` to expose `note_question`,
  `list_open_questions`, `dismiss_question` to the agent
- `hydra-acp/commands/register` to expose `/hydra clarifier
  {answer,dismiss,list}` to users
- `hydra-acp/attention/{set,clear}` to raise/lower a `reason: "questions"`
  flag whenever any question on a session is open

Clients learn of changes through the daemon's existing
`hydra-acp/session/attention_updated` notification — no clarifier-specific
broadcast.

## Layout

- `src/index.ts` — entry point
- `src/bridge.ts` — transformer WS connection (**large — ~750 lines**;
  inlines transformer message dispatch, MCP tool invocation dispatch,
  migration, self-attach lifecycle, and attention-flag daemon RPC in one
  class. Splitting is straightforward but risks separating the in-memory
  question map from its RPC side effects — read before refactoring)
- `src/mcp-tools.ts` — the three agent-facing MCP tools
- `src/question.ts` — the question data model + lifecycle
- `src/paths.ts` — per-session state file layout
- `src/acp/`, `src/util/`

Per-session state lives in
`~/.hydra-acp/sessions/<sessionId>/clarifier-questions.json`, co-located
with `meta.json` so removing a session also removes its questions.

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-clarifier` on PATH. Registered via
`hydra-acp transformer add hydra-acp-clarifier`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- **Reuse hydra primitives; do not invent new ACP methods here.** If you
  need a capability that doesn't exist, add it to `hydra-acp/cli` first.
- Question IDs are stable and shown to users. Don't regenerate them across
  restarts.
- The transformer must be fail-open: an error in question storage cannot
  break the turn.

## Gotchas

- Attention flag `reason` string is a protocol contract with clients —
  don't change `"questions"` without coordinating with TUI/browser/slack.
- After compaction, the agent uses `list_open_questions` to re-hydrate.
  The returned shape is part of its context; keep the schema stable.
- Dismissing the last open question must call `attention/clear`; missing
  this leaves stale badges in every client.
- **Two-stage startup migration** (`bridge.ts`): stage 1 is a one-shot
  file→daemon migration of the older per-session
  `clarifier-questions.json`; stage 2 loads from the daemon's attention
  flags (the canonical source). Stage 1 deletes files after successful
  push; a partial run leaves the file, and the next boot reruns the
  migration — designed idempotent, don't "clean up" by making it
  destructive-on-first-try.
- **`ensureAttached` polls cold sessions** at 5s (same shape as planner).
  `pendingAttach` is drained when the session warms; removing the poll
  means MCP tool calls on cold-then-warmed sessions won't route.
- **Answer semantics are stateful**: if the user's answer equals the
  `defaultAnswer` → `closed` with `closureReason: "default-accepted"`.
  Otherwise `pending-delivery` and `deviated=true`. Only
  `deviated + pending-delivery` entries get prepended to the next
  outgoing prompt. Silently normalizing these states will break the
  "surface only meaningful deviations to the agent" contract.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
