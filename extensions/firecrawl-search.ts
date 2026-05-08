import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Firecrawl from "@mendable/firecrawl-js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

function readEnvValue(name: string) {
  if (process.env[name]) return process.env[name];

  const envPath = join(homedir(), ".pi", "agent", ".env");
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== name) continue;

    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value.replace(/\s+#.*$/, "");
  }

  return undefined;
}

function createClient() {
  const apiKey = readEnvValue("FIRECRAWL_API_KEY");
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY in environment or ~/.pi/agent/.env");
  }

  return new Firecrawl({ apiKey });
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search Web",
    description: "Search web/news/images with Firecrawl; optionally scrape result markdown.",
    promptSnippet: "Search the web with Firecrawl for current information.",
    promptGuidelines: [
      "Use when the user asks for current web info, discovery, or sources beyond the workspace.",
      "Use scrape after search when a result needs full markdown content.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The web search query." }),
      limit: Type.Optional(Type.Number({ description: "Max results; default 5.", minimum: 1, maximum: 20 })),
      source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
      scrapeResults: Type.Optional(Type.Boolean({ description: "Include page markdown; default false." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        onUpdate?.({ content: [{ type: "text", text: `Searching Firecrawl for: ${params.query}` }] });

        const client = createClient();
        const result = await client.search(params.query, {
          limit: params.limit ?? 5,
          sources: [params.source ?? "web"],
          scrapeOptions: params.scrapeResults ? { formats: ["markdown"], timeout: 30000 } : undefined,
          timeout: 30000,
        });

        if (signal?.aborted) throw new Error("Search cancelled");

        return {
          content: [{ type: "text", text: stringify(result) }],
          details: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Firecrawl search failed: ${asErrorMessage(error)}` }],
          details: { error: asErrorMessage(error) },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "scrape",
    label: "Scrape Page",
    description: "Fetch a URL as cleaned markdown with Firecrawl.",
    promptSnippet: "Fetch a known URL as readable markdown.",
    promptGuidelines: ["Use for known URLs; prefer over shell fetch because output is cleaned for agent context."],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch." }),
      onlyMainContent: Type.Optional(Type.Boolean({ description: "Main content only; default true." })),
      waitFor: Type.Optional(Type.Number({ description: "Wait ms before capture." })),
      timeout: Type.Optional(Type.Number({ description: "Timeout ms; default 30000." })),
      includeMetadata: Type.Optional(Type.Boolean({ description: "Append metadata; default false; details always include it." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        onUpdate?.({ content: [{ type: "text", text: `Scraping page with Firecrawl: ${params.url}` }] });

        const client = createClient();
        const document = await client.scrape(params.url, {
          formats: ["markdown"],
          onlyMainContent: params.onlyMainContent ?? true,
          waitFor: params.waitFor,
          timeout: params.timeout ?? 30000,
        });

        if (signal?.aborted) throw new Error("Scrape cancelled");

        const metadata = params.includeMetadata && document.metadata ? `\n\nMetadata:\n${stringify(document.metadata)}` : "";
        const markdown = document.markdown?.trim() || "No markdown content returned.";

        return {
          content: [{ type: "text", text: `${markdown}${metadata}` }],
          details: document,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Firecrawl scrape failed: ${asErrorMessage(error)}` }],
          details: { error: asErrorMessage(error) },
          isError: true,
        };
      }
    },
  });
}
