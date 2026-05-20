import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

  mkdirSync(dirname(stateOwner[stateKey].registryPath), { recursive: true });
  return stateOwner[stateKey];
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

function formatAge(startedAt: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function abbreviatePath(path: string) {
  const home = process.env.HOME;
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function escapeMarkdownTableCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatTable(records: ProcessRecord[]) {
  const rows = records.map((record) => {
    const cwd = truncate(abbreviatePath(record.cwd || "?"), 44);
    const command = truncate(record.command || "?", 100);

    return `| ${record.pid} | ${formatAge(record.startedAt)} | ${escapeMarkdownTableCell(cwd)} | ${escapeMarkdownTableCell(command)} |`;
  });

  return [
    `Found ${records.length} live agent-started process group${records.length === 1 ? "" : "s"}.`,
    "",
    "| PGID | Age | CWD | Command |",
    "| ---: | --- | --- | --- |",
    ...rows,
    "",
    "Use `/killall` to terminate these process groups.",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const state = getState();

  pi.registerCommand("ps", {
    description: "List live process groups started by the agent's bash tool",
    handler: async (_args, _ctx) => {
      const records = await readRecords(state.registryPath);
      const liveRecords = records.filter((record) => isProcessGroupAlive(record.pid));
      await writeRecords(state.registryPath, liveRecords);

      const content = liveRecords.length === 0
        ? "No live agent-started background processes found."
        : formatTable(liveRecords);

      pi.sendMessage({
        customType: "background-processes",
        content,
        display: true,
      });
    },
  });
}
