/**
 * Conversation context for suggestion prompts.
 *
 * Only `import type` from pi packages, so the digest helpers are unit-testable
 * with plain Node.
 *
 * Fork changes (pi-ghost-text-zh): the last assistant reply keeps a larger
 * budget, the digest includes cwd/project name and a brief summary of recent
 * tool calls, and the user's language is detected.
 *
 * @module
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectLanguage, languageInstruction, type LangCode } from "./language.ts";

export interface ContextWindow {
	messages: number;
	chars: number;
	/** Chars kept for the most recent assistant reply. */
	lastAssistantChars?: number;
	/** Number of recent tool calls summarized. */
	toolCalls?: number;
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown };
type Entry = { type?: string; message?: { role?: string; content?: string | Block[] } };

export function extractTextContent(content: string | Array<{ type: string; text?: string }> | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

/** Keep head and tail of long text: the end of a reply usually holds the question/next step. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max < 40) return text.slice(0, max);
	const head = Math.floor(max * 0.35);
	const tail = max - head - 5;
	return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`;
}

/**
 * Trimmed digest of the last user/assistant messages, oldest first.
 * The most recent assistant message gets `lastAssistantChars`.
 */
export function digestMessages(entries: readonly unknown[], opts: ContextWindow): string {
	const parts: string[] = [];
	let sawAssistant = false;
	for (let i = entries.length - 1; i >= 0 && parts.length < opts.messages; i--) {
		const entry = entries[i] as Entry;
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || typeof msg !== "object" || !("role" in msg)) continue;
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = extractTextContent(msg.content).trim();
		if (!text) continue;
		let budget = opts.chars;
		if (msg.role === "assistant" && !sawAssistant) {
			sawAssistant = true;
			budget = Math.max(opts.chars, opts.lastAssistantChars ?? opts.chars);
		}
		const label = msg.role === "user" ? "User" : "Assistant";
		parts.unshift(`${label}: ${clip(text, budget)}`);
	}
	return parts.join("\n\n");
}

/** Recent user message texts, newest last (for language detection). */
export function recentUserTexts(entries: readonly unknown[], max = 4): string[] {
	const out: string[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
		const entry = entries[i] as Entry;
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = extractTextContent(entry.message.content).trim();
		if (text) out.unshift(text);
	}
	return out;
}

function oneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short human-readable description of one tool call. */
export function describeToolCall(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const pick = (...keys: string[]) => {
		for (const k of keys) if (typeof a[k] === "string" && a[k]) return a[k] as string;
		return "";
	};
	const detail = pick("command", "path", "file_path", "pattern", "query", "url", "task", "prompt");
	return detail ? `${name}: ${oneLine(detail, 80)}` : name;
}

/** Summaries of the last `max` tool calls on the branch, oldest first. */
export function summarizeToolCalls(entries: readonly unknown[], max: number): string[] {
	if (max <= 0) return [];
	const out: string[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
		const entry = entries[i] as Entry;
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0 && out.length < max; j--) {
			const b = content[j]!;
			if (b.type === "toolCall" && typeof b.name === "string") out.unshift(describeToolCall(b.name, b.arguments));
		}
	}
	return out;
}

/** Project label: directory name plus package.json name when different. */
export function projectLabel(cwd: string): string {
	const dir = path.basename(cwd) || cwd;
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
		if (pkg && typeof pkg.name === "string" && pkg.name && pkg.name !== dir) return `${dir} (package: ${pkg.name})`;
	} catch {
		// no package.json
	}
	return dir;
}

export interface PromptParts {
	cwd: string;
	project: string;
	digest: string;
	tools: string[];
	lang: LangCode;
	partial: string;
}

export function buildPromptParts(entries: readonly unknown[], cwd: string, partial: string, opts: ContextWindow): PromptParts {
	return {
		cwd,
		project: projectLabel(cwd),
		digest: digestMessages(entries, opts),
		tools: summarizeToolCalls(entries, opts.toolCalls ?? 8),
		lang: detectLanguage([...recentUserTexts(entries), partial]),
		partial,
	};
}

/** Text of the user message for the cheap-model (standalone) strategy. */
export function renderStandalonePrompt(p: PromptParts): string {
	const sections = [
		`Working directory: ${p.cwd}\nProject: ${p.project}`,
		p.tools.length ? `Recent tool calls (oldest first):\n${p.tools.map((t) => `- ${t}`).join("\n")}` : "",
		`Recent conversation (oldest first):\n${p.digest || "(no conversation yet)"}`,
		languageInstruction(p.lang),
		p.partial
			? `Partial input (must be the exact start of your output):\n"""${p.partial}"""`
			: "The input box is empty. Predict the user's next prompt.",
	];
	return sections.filter(Boolean).join("\n\n");
}

/** Text appended as the final user turn for the session (cache-reuse) strategy. */
export function renderForkPrompt(p: PromptParts, instructions: string): string {
	return [
		instructions,
		`Project: ${p.project} (cwd ${p.cwd}).`,
		languageInstruction(p.lang),
		p.partial
			? `The user has typed this partial input; your output MUST start with it exactly:\n"""${p.partial}"""`
			: "The input box is empty.",
	].join("\n\n");
}

export function buildUserMessage(ctx: ExtensionContext, partial: string, opts: ContextWindow): UserMessage {
	const parts = buildPromptParts(ctx.sessionManager.getBranch(), ctx.cwd, partial, opts);
	return {
		role: "user",
		content: [{ type: "text", text: renderStandalonePrompt(parts) }],
		timestamp: Date.now(),
	};
}
