import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, estimateTokens, serializeConversation } from "@mariozechner/pi-coding-agent";

const KEEP_TAIL_TOKENS = 40_000;
const SYSTEM_PROMPT = "You are a precise coding-agent session summarizer. Return only a structured markdown summary. Do not call tools.";

type Message = Parameters<typeof estimateTokens>[0];

type MessageEntry = {
	type: "message";
	id: string;
	message: Message;
};

type CompactionEntry = {
	type: "compaction";
	id: string;
	summary: string;
	tokensBefore: number;
};

const isMessageEntry = (entry: unknown): entry is MessageEntry => {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as { type?: unknown; id?: unknown; message?: unknown };
	return candidate.type === "message" && typeof candidate.id === "string" && !!candidate.message;
};

const isCompactionEntry = (entry: unknown): entry is CompactionEntry => {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as { type?: unknown; id?: unknown; summary?: unknown; tokensBefore?: unknown };
	return (
		candidate.type === "compaction" &&
		typeof candidate.id === "string" &&
		typeof candidate.summary === "string" &&
		typeof candidate.tokensBefore === "number"
	);
};

const tokenSum = (messages: Message[]) => messages.reduce((total, message) => total + estimateTokens(message), 0);

const isValidCutPoint = (entry: MessageEntry | undefined) => {
	const role = entry?.message.role;
	return role === "user" || role === "assistant" || role === "bashExecution" || role === "custom" || role === "branchSummary";
};

const getTailStartIndex = (entries: MessageEntry[]) => {
	let tokens = 0;
	let tailStartIndex = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const nextTokens = estimateTokens(entries[i].message);
		if (tokens > 0 && tokens + nextTokens > KEEP_TAIL_TOKENS) {
			tailStartIndex = i + 1;
			break;
		}
		tokens += nextTokens;
	}

	while (tailStartIndex > 0 && !isValidCutPoint(entries[tailStartIndex])) {
		tailStartIndex--;
	}

	return tailStartIndex;
};

const buildMessageText = (message: Message) => serializeConversation(convertToLlm([message]));

const buildSummaryPrompt = (priorSummary: string | undefined, firstMessageText: string | undefined, middleHistoryText: string) => `You are semi-compacting a coding-agent session.

Pi compaction keeps one contiguous recent tail verbatim. Existing prior compaction summaries and/or the original first message must be preserved in this new summary. The newest tail of the session will remain verbatim and is not included below.

Preserve:
1. Original first message / root request and any constraints
2. Prior compaction summaries if present
3. User goals and instructions
4. Decisions, constraints, preferences, and rejected options
5. Files inspected or changed, with paths when available
6. Commands run and important outputs or errors
7. Installed packages, config changes, keys/settings locations, and created files
8. Current state, unresolved questions, and next steps

Be concise but information-dense. Do not invent anything. Use structured markdown.

${priorSummary ? `<prior_compaction_summary>\n${priorSummary}\n</prior_compaction_summary>\n\n` : ""}${firstMessageText ? `<first_message>\n${firstMessageText}\n</first_message>\n\n` : ""}<middle_history_to_summarize>
${middleHistoryText}
</middle_history_to_summarize>`;

export default function (pi: ExtensionAPI) {
	let pendingCommand = false;
	let cancelledAsNoop = false;

	pi.on("session_before_compact", async (event, ctx) => {
		const isCommandRun = pendingCommand;
		pendingCommand = false;
		cancelledAsNoop = false;

		const branch = event.branchEntries;
		let priorSummary: string | undefined;
		let searchStart = 0;
		const latestCompactionIndex = branch.findLastIndex(isCompactionEntry);
		if (latestCompactionIndex >= 0) {
			const latestCompaction = branch[latestCompactionIndex] as CompactionEntry;
			priorSummary = latestCompaction.summary;
			const firstKeptIndex = branch.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId);
			searchStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1;
		}

		const entries = branch
			.slice(searchStart)
			.filter((entry) => isMessageEntry(entry) && (latestCompactionIndex < 0 || branch.indexOf(entry) !== latestCompactionIndex));
		if (entries.length < 2) {
			cancelledAsNoop = true;
			ctx.ui.notify("Semi-compaction skipped: not enough new history since the last compaction", "info");
			return isCommandRun ? { cancel: true } : undefined;
		}

		const tailStartIndex = Math.max(0, getTailStartIndex(entries));
		const middleEntries = entries.slice(0, tailStartIndex);
		const keptEntries = entries.slice(tailStartIndex);
		const firstKeptEntryId = keptEntries[0]?.id;

		if (!firstKeptEntryId) {
			ctx.ui.notify("Could not find first kept tail entry", "error");
			return isCommandRun ? { cancel: true } : undefined;
		}

		if (middleEntries.length === 0) {
			cancelledAsNoop = true;
			ctx.ui.notify("Semi-compaction skipped: the recent tail is already under 40k tokens", "info");
			return isCommandRun ? { cancel: true } : undefined;
		}

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No active model available for semi-compaction", "error");
			return isCommandRun ? { cancel: true } : undefined;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Semi-compaction auth failed: ${auth.error}`, "error");
			return isCommandRun ? { cancel: true } : undefined;
		}
		if (!auth.apiKey) {
			ctx.ui.notify(`No API key for ${model.provider}`, "error");
			return isCommandRun ? { cancel: true } : undefined;
		}

		const firstMessageText = priorSummary ? undefined : buildMessageText(entries[0].message);
		const middleMessages = middleEntries.map((entry) => entry.message);
		const middleHistoryText = serializeConversation(convertToLlm(middleMessages));
		const tokensBefore = (priorSummary ? estimateTokens({ role: "compactionSummary", summary: priorSummary, tokensBefore: 0, timestamp: Date.now() }) : 0) + tokenSum(middleMessages);
		const keptTokens = tokenSum(keptEntries.map((entry) => entry.message));

		ctx.ui.notify(
			`Semi-compacting ${middleEntries.length} messages; keeping ${keptEntries.length} recent messages (~${keptTokens.toLocaleString()} tokens)...`,
			"info",
		);

		const response = await complete(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: buildSummaryPrompt(priorSummary, firstMessageText, middleHistoryText) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 8192,
				signal: event.signal,
			},
		);

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			ctx.ui.notify(response.errorMessage ?? `Semi-compaction failed: ${response.stopReason}`, "error");
			return isCommandRun ? { cancel: true } : undefined;
		}

		const summary = response.content
			.map((content) => ("text" in content && typeof content.text === "string" ? content.text : ""))
			.join("\n")
			.trim();

		if (!summary) {
			const contentTypes = response.content.map((content) => content.type).join(", ") || "none";
			ctx.ui.notify(`Semi-compaction summary was empty; response content types: ${contentTypes}`, "error");
			return isCommandRun ? { cancel: true } : undefined;
		}

		return {
			compaction: {
				summary: `Semi-compaction summary. Prior summaries and older history have been summarized; the newest ~${KEEP_TAIL_TOKENS.toLocaleString()} tokens remain verbatim below.\n\n${summary}`,
				firstKeptEntryId,
				tokensBefore,
				details: {
					kind: "semicompact",
					previousCompactionId: latestCompactionIndex >= 0 ? (branch[latestCompactionIndex] as CompactionEntry).id : undefined,
					summarizedMessages: middleEntries.length,
					keptMessages: keptEntries.length,
					keepTailTokens: KEEP_TAIL_TOKENS,
					estimatedKeptTokens: keptTokens,
					firstKeptEntryId,
				},
			},
		};
	});

	pi.registerCommand("semicompact", {
		description: "Summarize history before the newest 40k tokens using Pi's native compaction path",
		handler: async (_args, ctx) => {
			pendingCommand = true;
			ctx.compact({
				onComplete: () => ctx.ui.notify("Semi-compaction complete", "success"),
				onError: (error) => {
					pendingCommand = false;
					if (cancelledAsNoop && error.message === "Compaction cancelled") {
						cancelledAsNoop = false;
						return;
					}
					cancelledAsNoop = false;
					ctx.ui.notify(`Semi-compaction failed: ${error.message}`, "error");
				},
			});
		},
	});
}
