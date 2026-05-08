import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type McpClientState = {
	client: Client;
	transport: StdioClientTransport;
};

let state: McpClientState | undefined;

const getPlaywrightMcpEnv = () => {
	const env = getDefaultEnvironment();
	for (const key of [
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"XDG_RUNTIME_DIR",
		"DBUS_SESSION_BUS_ADDRESS",
		"XAUTHORITY",
		"XDG_SESSION_TYPE",
		"GDK_BACKEND",
		"QT_QPA_PLATFORM",
	]) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
};

const connect = async () => {
	if (state) return state.client;

	const client = new Client(
		{ name: "pi-playwright-mcp-bridge", version: "0.1.0" },
		{ capabilities: {} },
	);
	const transport = new StdioClientTransport({
		command: "npx",
		// Use Playwright's bundled Chromium instead of the Google Chrome channel.
		// This machine has Chromium installed and Playwright browsers cached, but not
		// Google Chrome at /opt/google/chrome/chrome, so the default MCP launch fails
		// with "Chromium distribution 'chrome' is not found".
		// Use an isolated browser profile so multiple MCP sessions do not collide on
		// the same persisted Chrome-for-Testing profile directory.
		args: ["@playwright/mcp@latest", "--browser", "chromium", "--isolated"],
		// The MCP stdio transport only inherits a very small set of environment
		// variables by default, which omits desktop session variables like DISPLAY
		// and WAYLAND_DISPLAY. Forward the current GUI session env so Playwright can
		// launch a visible browser window instead of falling back to headless mode.
		env: getPlaywrightMcpEnv(),
		stderr: "pipe",
	});

	await client.connect(transport);
	state = { client, transport };
	return client;
};

const disconnect = async () => {
	if (!state) return;
	const current = state;
	state = undefined;
	await current.client.close();
};

const formatMcpContent = (content: unknown) => {
	if (!Array.isArray(content)) return [{ type: "text" as const, text: JSON.stringify(content, null, 2) }];

	return content.map((item) => {
		if (!item || typeof item !== "object") return { type: "text" as const, text: String(item) };
		const entry = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
		if (entry.type === "text" && typeof entry.text === "string") {
			return { type: "text" as const, text: entry.text };
		}
		if (entry.type === "image" && typeof entry.data === "string") {
			return {
				type: "image" as const,
				data: entry.data,
				mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "image/png",
			};
		}
		return { type: "text" as const, text: JSON.stringify(item, null, 2) };
	});
};

type McpToolCallParams = {
	name: string;
	arguments?: Record<string, unknown>;
	argumentsJson?: string;
};

const parseToolArguments = (params: McpToolCallParams) => {
	if (!params.argumentsJson?.trim()) return params.arguments ?? {};

	const parsed = JSON.parse(params.argumentsJson) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("argumentsJson must parse to a JSON object.");
	}
	return parsed as Record<string, unknown>;
};

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "mcp_playwright_list_tools",
			label: "MCP Playwright: list tools",
			description: "List Playwright MCP browser tools.",
			promptSnippet: "List Playwright MCP browser tools.",
			parameters: Type.Object({}),
			async execute() {
				const client = await connect();
				const result = await client.listTools();
				const lines = result.tools.map((tool) => {
					const description = tool.description ? ` — ${tool.description}` : "";
					const inputSchema = tool.inputSchema ? `\n  inputSchema: ${JSON.stringify(tool.inputSchema)}` : "";
					return `- ${tool.name}${description}${inputSchema}`;
				});
				return {
					content: [{ type: "text", text: lines.join("\n") || "No MCP tools exposed." }],
					details: result,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "mcp_playwright_call_tool",
			label: "MCP Playwright: call tool",
			description: "Call a Playwright MCP browser tool; use mcp_playwright_list_tools first to discover names/args.",
			promptSnippet: 'Call a listed Playwright MCP tool, e.g. {"name":"browser_navigate","argumentsJson":"{\\"url\\":\\"https://example.com\\"}"}.',
			parameters: Type.Object({
				name: Type.String({ description: "MCP tool name." }),
				argumentsJson: Type.Optional(
					Type.String({ description: "JSON object string of args; use instead of top-level url/click/etc." }),
				),
			}),
			async execute(_toolCallId, params: McpToolCallParams, signal) {
				const client = await connect();
				const result = await client.callTool(
					{ name: params.name, arguments: parseToolArguments(params) },
					undefined,
					signal ? { signal } : undefined,
				);
				return {
					content: formatMcpContent(result.content),
					details: result,
					isError: result.isError === true,
				};
			},
		}),
	);

	pi.registerCommand("mcp-playwright-restart", {
		description: "Restart the Playwright MCP server connection",
		handler: async (_args, ctx) => {
			await disconnect();
			await connect();
			ctx.ui.notify("Playwright MCP server restarted", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await disconnect();
	});
}
