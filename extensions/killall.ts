import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SignalConstants } from "node:os";
import { spawnSync } from "node:child_process";
import {
  createBashToolDefinition,
  type BashSpawnContext,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

type KillallState = {
  registryPath: string;
  initialized: boolean;
};

type ProcessRecord = {
  pid: number;
  startedAt: number;
  cwd: string;
  command: string;
};

const stateKey = Symbol.for("pi.extension.killall.state");
const stateOwner = globalThis as typeof globalThis & {
  [stateKey]?: KillallState;
};

function getState() {
  stateOwner[stateKey] ??= {
    registryPath: join(tmpdir(), `pi-killall-${process.pid}.tsv`),
    initialized: false,
  };

  const state = stateOwner[stateKey];
  if (!state.initialized) {
    mkdirSync(dirname(state.registryPath), { recursive: true });
    writeFileSync(state.registryPath, "", { flag: "w" });
    state.initialized = true;
  }

  return state;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decode(value: string) {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function withKillallTracking(context: BashSpawnContext, registryPath: string): BashSpawnContext {
  const cwd = encode(context.cwd);
  const command = encode(context.command);
  const prefix = [
    "{",
    "printf '%s\\t%s\\t%s\\t%s\\n'",
    '"$$"',
    '"$(date +%s)"',
    shellQuote(cwd),
    shellQuote(command),
    ">>",
    shellQuote(registryPath),
    ";",
    "} 2>/dev/null || true",
  ].join(" ");

  return {
    ...context,
    command: `${prefix}\n${context.command}`,
  };
}

async function readRecords(registryPath: string) {
  let text = "";
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const records = new Map<number, ProcessRecord>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    const [pidText, startedAtText, cwdText, commandText] = line.split("\t");
    const pid = Number(pidText);
    const startedAt = Number(startedAtText);

    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (!Number.isFinite(startedAt) || startedAt <= 0) continue;

    records.set(pid, {
      pid,
      startedAt,
      cwd: decode(cwdText ?? ""),
      command: decode(commandText ?? ""),
    });
  }

  return [...records.values()];
}

async function writeRecords(registryPath: string, records: ProcessRecord[]) {
  const lines = records.map((record) =>
    [record.pid, record.startedAt, encode(record.cwd), encode(record.command)].join("\t"),
  );
  await writeFile(registryPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}

function isProcessGroupAlive(pid: number) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(pid: number, signal: keyof SignalConstants) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  const state = getState();

  pi.on("session_start", (_event, ctx) => {
    pi.registerTool(
      createBashToolDefinition(ctx.cwd, {
        spawnHook: (context) => withKillallTracking(context, state.registryPath),
      }),
    );
  });

  pi.registerCommand("killall", {
    description: "Kill live process groups started by the agent's bash tool",
    handler: async (_args, ctx) => {
      const records = await readRecords(state.registryPath);
      const liveRecords = records.filter((record) => isProcessGroupAlive(record.pid));

      if (liveRecords.length === 0) {
        await writeRecords(state.registryPath, []);
        ctx.ui.notify("No live agent-started background processes found.", "info");
        return;
      }

      for (const record of liveRecords) {
        signalProcessGroup(record.pid, "SIGTERM");
      }

      await sleep(750);

      const stillAliveAfterTerm = liveRecords.filter((record) => isProcessGroupAlive(record.pid));
      for (const record of stillAliveAfterTerm) {
        signalProcessGroup(record.pid, "SIGKILL");
      }

      await sleep(250);

      const survivors = liveRecords.filter((record) => isProcessGroupAlive(record.pid));
      await writeRecords(state.registryPath, survivors);

      const killed = liveRecords.length - survivors.length;
      const message = survivors.length === 0
        ? `Killed ${killed} agent-started process group${killed === 1 ? "" : "s"}.`
        : `Killed ${killed} process group${killed === 1 ? "" : "s"}; ${survivors.length} still appear alive.`;

      ctx.ui.notify(message, survivors.length === 0 ? "success" : "warning");
    },
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit" && existsSync(state.registryPath)) {
      const survivors = (await readRecords(state.registryPath)).filter((record) =>
        isProcessGroupAlive(record.pid),
      );
      await writeRecords(state.registryPath, survivors);
    }
  });
}
