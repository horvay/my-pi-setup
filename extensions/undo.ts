import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type SessionEntry = ReturnType<ExtensionAPI["appendEntry"]> extends never ? never : {
	id: string;
	parentId: string | null;
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const isUserMessageEntry = (entry: unknown): entry is SessionEntry => {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as {
		type?: unknown;
		id?: unknown;
		parentId?: unknown;
		message?: { role?: unknown; content?: unknown };
	};
	return (
		candidate.type === "message" &&
		typeof candidate.id === "string" &&
		(candidate.parentId === null || typeof candidate.parentId === "string") &&
		candidate.message?.role === "user"
	);
};

const textFromContent = (content: unknown) => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (!("type" in block)) return "";
			if (block.type !== "text" || !("text" in block) || typeof block.text !== "string") return "";
			return block.text;
		})
		.join("");
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("undo", {
		description: "Undo the last user turn and restore its prompt into the editor",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch();
			let lastUserEntry: SessionEntry | undefined;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (isUserMessageEntry(entry)) {
					lastUserEntry = entry;
					break;
				}
			}

			if (!lastUserEntry) {
				ctx.ui.notify("Nothing to undo: no user turn found in this session", "info");
				return;
			}

			const undoneText = textFromContent(lastUserEntry.message?.content);
			const result = await ctx.navigateTree(lastUserEntry.id, { summarize: false });
			if (result.cancelled) return;

			ctx.ui.setEditorText(result.editorText ?? undoneText);
			ctx.ui.notify("Undid last turn and restored it to the editor. Use /tree to return to the abandoned branch.", "info");
		},
	});
}
