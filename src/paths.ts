import { homedir } from "node:os";
import { resolve } from "node:path";

// hydra-acp injects HYDRA_ACP_HOME when it spawns transformers; this file
// is invoked both in that role and as a one-shot subcommand from the
// user's shell, so fall back to ~/.hydra-acp when the env isn't set.
function hydraHome(): string {
  return process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
}

// Directory used at startup for one-shot migration of legacy
// clarifier-questions.json files (pre-attention-flag-only persistence).
// After migration completes there's no recurring need to enumerate sessions —
// state lives in the daemon's attention flags. Kept for the migration scan.
export function sessionsDir(): string {
  return resolve(hydraHome(), "sessions");
}

// Legacy per-session questions file path. Only referenced by the one-shot
// migration scan in bridge.ts (which builds the path inline now). Removed
// from the public API as part of the attention-flag-only persistence
// consolidation.
