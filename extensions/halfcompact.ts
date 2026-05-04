import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, estimateTokens, serializeConversation } from "@mariozechner/pi-coding-agent";

type MessageEntry = {
	type: "message";
	id: string;
	message: Parameters<typeof estimateTokens>[0];
};

const isMessageEntry = (entry: unknown): entry is MessageEntry => {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as { type?: unknown; id?: unknown; message?: unknown };
	return candidate.type === "message" && typeof candidate.id === "string" && !!candidate.message;
};

const buildSummaryPrompt = (conversationText: string) => `You are compacting the older half of a coding-agent session.

Summarize what occurred in the history below so future turns can continue without rereading it. Preserve:

1. User goals and instructions
2. Decisions, constraints, preferences, and rejected options
3. Files inspected or changed, with paths when available
4. Commands run and important outputs or errors
5. Installed packages, config changes, keys/settings locations, and created files
6. Current state, unresolved questions, and next steps

Be concise but information-dense. Do not invent anything. Use structured markdown.

<older_history>
${conversationText}
</older_history>`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("halfcompact", {
		description: "Compact the older half of the current session into a summary while keeping the newer half verbatim",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch();
			const messageEntries = branch.filter(isMessageEntry);

			if (messageEntries.length < 4) {
				ctx.ui.notify("Not enough message history to half-compact", "warning");
				return;
			}

			const splitIndex = Math.floor(messageEntries.length / 2);
			const toSummarize = messageEntries.slice(0, splitIndex);
			const toKeep = messageEntries.slice(splitIndex);
			const firstKeptEntryId = toKeep[0]?.id;

			if (!firstKeptEntryId) {
				ctx.ui.notify("Could not find first kept entry", "error");
				return;
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model available for half-compaction", "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(`Half-compaction auth failed: ${auth.error}`, "error");
				return;
			}
			if (!auth.apiKey) {
				ctx.ui.notify(`No API key for ${model.provider}`, "error");
				return;
			}

			const messages = toSummarize.map((entry) => entry.message);
			const tokensBefore = messages.reduce((total, message) => total + estimateTokens(message), 0);
			const conversationText = serializeConversation(convertToLlm(messages));

			ctx.ui.notify(
				`Half-compacting ${toSummarize.length} older messages; keeping ${toKeep.length} recent messages...`,
				"info",
			);

			const response = await complete(
				model,
				{
					systemPrompt:
						"You are a precise coding-agent session summarizer. Return only a structured markdown summary. Do not call tools.",
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 8192,
				},
			);

			if (response.stopReason === "error" || response.stopReason === "aborted") {
				ctx.ui.notify(response.errorMessage ?? `Half-compaction failed: ${response.stopReason}`, "error");
				return;
			}

			const summary = response.content
				.map((content) => ("text" in content && typeof content.text === "string" ? content.text : ""))
				.join("\n")
				.trim();

			if (!summary) {
				const contentTypes = response.content.map((content) => content.type).join(", ") || "none";
				ctx.ui.notify(`Half-compaction summary was empty; response content types: ${contentTypes}`, "error");
				return;
			}

			ctx.sessionManager.appendCompaction(
				`Half-compaction summary of the older half of this session:\n\n${summary}`,
				firstKeptEntryId,
				tokensBefore,
				{
					kind: "halfcompact",
					summarizedMessages: toSummarize.length,
					keptMessages: toKeep.length,
					firstKeptEntryId,
				},
				true,
			);

			ctx.ui.notify("Half-compaction complete; reloading session context...", "success");
			await ctx.reload();
			return;
		},
	});
}
