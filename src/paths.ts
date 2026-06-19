import { homedir } from "node:os";
import { resolve } from "node:path";

// hydra-acp injects HYDRA_ACP_HOME when it spawns transformers; this file
// is invoked both in that role and as a one-shot subcommand from the
// user's shell, so fall back to ~/.hydra-acp when the env isn't set.
function hydraHome(): string {
  return process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
}

// Per-session question store. Each session's questions live in
// <home>/sessions/<sessionId>/clarifier-questions.json, alongside the
// session's own meta.json and history.jsonl. Co-located so removing a
// session also removes its clarifier state.
export function questionsFilePath(sessionId: string): string {
  return resolve(
    hydraHome(),
    "sessions",
    sessionId,
    "clarifier-questions.json",
  );
}

// Directory enumerated at startup to discover sessions that may have
// pending questions (for reconcile and cross-session listing without
// having to ask the daemon for every session).
export function sessionsDir(): string {
  return resolve(hydraHome(), "sessions");
}
