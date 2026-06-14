import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const getPlaywrightMcpUserDataDir = () => {
	const home = process.env.HOME || process.cwd();
	const dir = join(home, ".pi", "agent", ".playwright-mcp", "user-data");
	mkdirSync(dir, { recursive: true });
	return dir;
};

const getPlaywrightMcpConfigPath = () => {
	const home = process.env.HOME || process.cwd();
	const dir = join(home, ".pi", "agent", ".playwright-mcp");
	mkdirSync(dir, { recursive: true });
	return join(dir, "config.json");
};

const getPlaywrightMcpLaunchArgs = () => {
	// NVIDIA/Wayland/Hyprland can hard-freeze when headed Chromium exercises GPU-heavy
	// pages like Grok Imagine. Keep GPU acceleration off by default for Pi's MCP browser.
	// Set PI_PLAYWRIGHT_MCP_DISABLE_GPU=0 to opt back into GPU acceleration.
	if (process.env.PI_PLAYWRIGHT_MCP_DISABLE_GPU === "0") return [];
	return [
		"--disable-gpu",
		"--disable-gpu-compositing",
		"--disable-accelerated-2d-canvas",
		"--disable-accelerated-video-decode",
		"--disable-features=VaapiVideoDecoder,VaapiVideoEncoder,Vulkan,UseSkiaRenderer",
		"--disable-vulkan",
		"--use-gl=swiftshader",
	];
};

const writePlaywrightMcpConfig = () => {
	const configPath = getPlaywrightMcpConfigPath();
	const isolated = process.env.PI_PLAYWRIGHT_MCP_ISOLATED === "1";
	const config = {
		browser: {
			browserName: "chromium",
			isolated,
			...(isolated ? {} : { userDataDir: getPlaywrightMcpUserDataDir() }),
			launchOptions: {
				args: getPlaywrightMcpLaunchArgs(),
			},
		},
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	return configPath;
};

const getPlaywrightMcpArgs = () => ["@playwright/mcp@latest", "--config", writePlaywrightMcpConfig()];

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
		// Use a dedicated persistent profile so ChatGPT/OpenAI subscription login
		// survives MCP restarts and future Pi sessions. Set PI_PLAYWRIGHT_MCP_ISOLATED=1
		// to restore throwaway in-memory sessions for one-off testing.
		args: getPlaywrightMcpArgs(),
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

const MAX_MCP_TEXT_CHARS = Number(process.env.PI_PLAYWRIGHT_MCP_MAX_TEXT_CHARS || 120_000);
const MAX_MCP_DETAILS_CHARS = Number(process.env.PI_PLAYWRIGHT_MCP_MAX_DETAILS_CHARS || 20_000);

const truncateText = (text: string, maxChars = MAX_MCP_TEXT_CHARS) => {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[pi mcp-playwright truncated ${omitted.toLocaleString()} chars. Rerun with a narrower browser_evaluate result or set PI_PLAYWRIGHT_MCP_MAX_TEXT_CHARS to raise this cap.]`;
};

const safeStringify = (value: unknown, maxChars = MAX_MCP_DETAILS_CHARS) => {
	try {
		return truncateText(JSON.stringify(value, null, 2), maxChars);
	} catch {
		return truncateText(String(value), maxChars);
	}
};

const formatMcpContent = (content: unknown) => {
	if (!Array.isArray(content)) return [{ type: "text" as const, text: safeStringify(content) }];

	return content.map((item) => {
		if (!item || typeof item !== "object") return { type: "text" as const, text: truncateText(String(item)) };
		const entry = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
		if (entry.type === "text" && typeof entry.text === "string") {
			return { type: "text" as const, text: truncateText(entry.text) };
		}
		if (entry.type === "image" && typeof entry.data === "string") {
			return {
				type: "image" as const,
				data: entry.data,
				mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "image/png",
			};
		}
		return { type: "text" as const, text: safeStringify(item) };
	});
};

const formatMcpDetails = (result: unknown) => ({
	truncated: true,
	preview: safeStringify(result),
});

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

const compactPageFunction = `() => {
	const visible = (el) => {
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
	};
	const text = (value, max = 120) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	const css = (el) => {
		if (el.id) return \`#\${CSS.escape(el.id)}\`;
		const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
		if (testId) return \`[data-testid="\${CSS.escape(testId)}"]\`;
		const aria = el.getAttribute("aria-label");
		if (aria) return \`\${el.tagName.toLowerCase()}[aria-label="\${CSS.escape(aria)}"]\`;
		return el.tagName.toLowerCase();
	};
	const elements = [...document.querySelectorAll("button,a,input,textarea,select,[role=button],[contenteditable=true]")]
		.filter(visible)
		.slice(0, 80)
		.map((el, i) => ({
			i,
			tag: el.tagName.toLowerCase(),
			role: el.getAttribute("role") || undefined,
			text: text(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder")),
			aria: text(el.getAttribute("aria-label")),
			placeholder: text(el.getAttribute("placeholder")),
			type: el.getAttribute("type") || undefined,
			disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
			selector: css(el),
			rect: rect(el),
		}));
	const images = [...document.images]
		.filter(visible)
		.filter((img) => img.naturalWidth > 100 || img.getBoundingClientRect().width > 100)
		.slice(0, 40)
		.map((img, i) => ({
			i,
			src: img.currentSrc || img.src,
			alt: text(img.alt),
			natural: { w: img.naturalWidth, h: img.naturalHeight },
			rect: rect(img),
		}));
	return { url: location.href, title: document.title, elements, images };
}`;

type CompactPageParams = {
	maxChars?: number;
};

type BrowserNavigateParams = {
	url: string;
};

type BrowserTextActionParams = {
	text: string;
};

type BrowserFillParams = {
	selector: string;
	value: string;
};

type BrowserEvaluateParams = {
	function: string;
	maxChars?: number;
};

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "browser_nav",
			label: "Browser: navigate",
			description: "Navigate the Playwright MCP browser with compact output.",
			promptSnippet: "Navigate browser to a URL.",
			parameters: Type.Object({
				url: Type.String({ description: "URL to open." }),
			}),
			async execute(_toolCallId, params: BrowserNavigateParams, signal) {
				const client = await connect();
				const result = await client.callTool(
					{ name: "browser_navigate", arguments: { url: params.url } },
					undefined,
					signal ? { signal } : undefined,
				);
				return {
					content: formatMcpContent(result.content),
					details: formatMcpDetails(result),
					isError: result.isError === true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "browser_page_compact",
			label: "Browser: compact page",
			description: "Return a compact browser page summary: URL, title, visible controls, and significant images. Prefer this over browser_snapshot.",
			promptSnippet: "Get compact browser page state.",
			parameters: Type.Object({
				maxChars: Type.Optional(Type.Number({ description: "Maximum returned text chars; default 120000." })),
			}),
			async execute(_toolCallId, params: CompactPageParams, signal) {
				const client = await connect();
				const result = await client.callTool(
					{ name: "browser_evaluate", arguments: { function: compactPageFunction } },
					undefined,
					signal ? { signal } : undefined,
				);
				return {
					content: formatMcpContent(result.content).map((entry) =>
						entry.type === "text" ? { ...entry, text: truncateText(entry.text, params.maxChars) } : entry,
					),
					details: formatMcpDetails(result),
					isError: result.isError === true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "browser_click_text",
			label: "Browser: click text",
			description: "Click the first visible button/link/control whose text, aria-label, placeholder, alt, or value contains the provided text. Compact output.",
			promptSnippet: "Click visible browser element by text.",
			parameters: Type.Object({
				text: Type.String({ description: "Case-insensitive text to match." }),
			}),
			async execute(_toolCallId, params: BrowserTextActionParams, signal) {
				const client = await connect();
				const needle = JSON.stringify(params.text);
				const fn = `() => {
					const q = String(${needle}).toLowerCase();
					const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
					const hay = (el) => [el.innerText, el.value, el.alt, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.title].filter(Boolean).join(" ").toLowerCase();
					const el = [...document.querySelectorAll("button,a,input,textarea,select,[role=button],[contenteditable=true],img")].find((candidate) => visible(candidate) && hay(candidate).includes(q));
					if (!el) return { clicked: false, error: "No visible matching element", needle: ${needle} };
					el.scrollIntoView({ block: "center", inline: "center" });
					el.click();
					return { clicked: true, tag: el.tagName.toLowerCase(), text: hay(el).slice(0, 200), url: location.href };
				}`;
				const result = await client.callTool(
					{ name: "browser_evaluate", arguments: { function: fn } },
					undefined,
					signal ? { signal } : undefined,
				);
				return { content: formatMcpContent(result.content), details: formatMcpDetails(result), isError: result.isError === true };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "browser_fill_selector",
			label: "Browser: fill selector",
			description: "Fill an input/textarea/contenteditable by CSS selector using compact Playwright MCP output.",
			promptSnippet: "Fill browser field by selector.",
			parameters: Type.Object({
				selector: Type.String({ description: "CSS selector." }),
				value: Type.String({ description: "Text to enter." }),
			}),
			async execute(_toolCallId, params: BrowserFillParams, signal) {
				const client = await connect();
				const selector = JSON.stringify(params.selector);
				const value = JSON.stringify(params.value);
				const fn = `() => {
					const selector = ${selector};
					const value = ${value};
					const el = document.querySelector(selector);
					if (!el) return { filled: false, error: "Selector not found", selector };
					el.scrollIntoView({ block: "center", inline: "center" });
					el.focus();
					if (el.isContentEditable) el.innerText = value;
					else el.value = value;
					el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
					el.dispatchEvent(new Event("change", { bubbles: true }));
					return { filled: true, selector, url: location.href };
				}`;
				const result = await client.callTool(
					{ name: "browser_evaluate", arguments: { function: fn } },
					undefined,
					signal ? { signal } : undefined,
				);
				return { content: formatMcpContent(result.content), details: formatMcpDetails(result), isError: result.isError === true };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "browser_eval_compact",
			label: "Browser: compact eval",
			description: "Run browser_evaluate but cap returned text. The function must return a small JSON-serializable result.",
			promptSnippet: "Evaluate compact browser JS.",
			parameters: Type.Object({
				function: Type.String({ description: "JavaScript function string for Playwright MCP browser_evaluate." }),
				maxChars: Type.Optional(Type.Number({ description: "Maximum returned text chars; default 120000." })),
			}),
			async execute(_toolCallId, params: BrowserEvaluateParams, signal) {
				const client = await connect();
				const result = await client.callTool(
					{ name: "browser_evaluate", arguments: { function: params.function } },
					undefined,
					signal ? { signal } : undefined,
				);
				return {
					content: formatMcpContent(result.content).map((entry) =>
						entry.type === "text" ? { ...entry, text: truncateText(entry.text, params.maxChars) } : entry,
					),
					details: formatMcpDetails(result),
					isError: result.isError === true,
				};
			},
		}),
	);

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
					details: formatMcpDetails(result),
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
					details: formatMcpDetails(result),
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
