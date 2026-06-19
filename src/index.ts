#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClarifierBridge } from "./bridge.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const HELP = `Usage: hydra-acp-clarifier [OPTIONS]

Runs as a hydra-acp transformer. Exposes the note_question / list_open_questions
MCP tools to the agent, persists per-session question state under
~/.hydra-acp/sessions/<id>/clarifier-questions.json, and uses the daemon's
attention-flag primitive (hydra-acp/attention/set | clear) to surface pending
questions on session-list awaitingInput.

Options:
  --debug      Enable debug-level logging.
  --version    Print version and exit.
  --help       Show this help.

Environment:
  HYDRA_ACP_HOME         Hydra data directory (default: ~/.hydra-acp)
  HYDRA_ACP_WS_URL       Daemon websocket URL (injected by hydra-acp on spawn).
  HYDRA_ACP_DAEMON_URL   Daemon HTTP base URL (injected by hydra-acp on spawn).
  HYDRA_ACP_TOKEN        Per-process transformer token (injected by hydra-acp).
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (argv.includes("--debug")) {
    setDebug(true);
  }

  log.info(`hydra-acp-clarifier ${readVersion()} starting`);

  const daemonWsUrl = process.env.HYDRA_ACP_WS_URL;
  if (!daemonWsUrl) {
    log.error("HYDRA_ACP_WS_URL must be set (injected by hydra-acp on spawn)");
    process.exit(1);
  }
  const daemonUrl = process.env.HYDRA_ACP_DAEMON_URL;
  if (!daemonUrl) {
    log.error("HYDRA_ACP_DAEMON_URL must be set (injected by hydra-acp on spawn)");
    process.exit(1);
  }
  const token = process.env.HYDRA_ACP_TOKEN;
  if (!token) {
    log.error("HYDRA_ACP_TOKEN must be set (injected by hydra-acp on spawn)");
    process.exit(1);
  }

  const bridge = new ClarifierBridge({ daemonWsUrl, daemonUrl, token });
  bridge.start();

  process.on("SIGTERM", () => {
    log.info("received SIGTERM, shutting down");
    bridge.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log.info("received SIGINT, shutting down");
    bridge.stop();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
