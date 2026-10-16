/**
 * pi-ghost-text-zh — fork of pi-ghost-text by Chris Vaughan (MIT).
 *
 * Fork changes: language-matched suggestions (Chinese conversation → Chinese
 * suggestion), richer context (longer last reply, cwd/project, recent tool
 * calls), and a "session" strategy that reuses the session model and prompt
 * prefix for prompt-cache hits (like Claude Code / Codex), with a "cheap"
 * small-model strategy as an option. /suggest-strategy switches.
 *
 * Prompt Suggestion - Claude Code-style ghost text in the prompt editor.
 *
 * As you type (or when the agent finishes and the input box is empty), a dimmed
 * suggestion of the likely prompt appears after the cursor.
 *
 * - Tab cycles candidates (or accepts) · Right arrow accepts
 * - Keep typing: the ghost shrinks if it still matches, otherwise it regenerates
 * - Escape / cursor movement away from the end: dismiss
 * - /suggest: choose mode (off / after-turn / while-typing / both)
 * - /suggest-model: pick the model used for suggestions
 * - /suggest-context: set context window (messages + chars per message)
 *
 * Config (resolved defaults <- global <- project):
 *   global:  ~/.pi/agent/prompt-suggestions-zh.json
 *   project: .pi/prompt-suggestions-zh.json
 *
 * Install as a pi package: pi install /path/to/pi-ghost-text
 * Quick test: pi -e ./src/index.ts
 *
 * @module
 */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CONFIG,
	readConfig,
	writeGlobalConfig,
	type Config,
} from "./config.ts";
import type { SuggestMode } from "./mode.ts";
import { scopedOrAvailable } from "./model-selection.ts";
import { configureDebug } from "./debug.ts";
import { extractTextContent } from "./context.ts";
import { SuggestingEditor } from "./editor.ts";

const MODES: Array<{ label: string; value: SuggestMode }> = [
	{ label: "both (while typing + after turn)", value: "both" },
	{ label: "while-typing (inline autocomplete)", value: "while-typing" },
	{ label: "after-turn (next prompt when empty)", value: "after-turn" },
	{ label: "off", value: "off" },
];

export default function (pi: ExtensionAPI): void {
	let config: Config = DEFAULT_CONFIG;
	let editor: SuggestingEditor | null = null;

	pi.registerCommand("suggest", {
		description: "Choose when prompt suggestions appear",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select(
				"Suggestion mode:",
				MODES.map((m) => m.label),
			);
			if (!choice) return;
			const mode = MODES.find((m) => m.label === choice)?.value ?? "off";
			config.mode = mode;
			saveGlobalConfig({ mode }, ctx);
			if (!whileTypingOrAfterTurn(mode)) editor?.clearGhost();
			ctx.ui.notify(`Prompt suggestions: ${mode}`, "info");
		},
	});

	pi.registerCommand("suggest-strategy", {
		description: "Session model + prompt cache, or a cheap separate model",
		handler: async (_args, ctx) => {
			const options = [
				{ label: "session (same model, reuse prompt cache — default)", value: "session" as const },
				{ label: "cheap (separate small model, compact context)", value: "cheap" as const },
			];
			const choice = await ctx.ui.select("Suggestion strategy:", options.map((o) => o.label));
			if (!choice) return;
			const strategy = options.find((o) => o.label === choice)?.value ?? "session";
			config.strategy = strategy;
			saveGlobalConfig({ strategy }, ctx);
			ctx.ui.notify(`Suggestion strategy: ${strategy}`, "info");
		},
	});

	pi.registerCommand("suggest-model", {
		description: "Choose the model used for prompt suggestions",
		handler: async (_args, ctx) => {
			const pool = scopedOrAvailable(ctx);
			const entries = [
				{ label: "auto (fast cheap model, same provider first)", value: "auto" },
				...pool.map((m) => ({ label: `${m.provider}/${m.id}`, value: `${m.provider}/${m.id}` })),
			];
			const choice = await ctx.ui.select("Cheap-strategy suggestion model:", entries.map((e) => e.label));
			if (!choice) return;
			const picked = entries.find((e) => e.label === choice);
			const value = picked ? picked.value : "auto";
			config.model = value;
			saveGlobalConfig({ model: value }, ctx);
			ctx.ui.notify(`Suggestion model: ${value}`, "info");
		},
	});

	pi.registerCommand("suggest-context", {
		description: "Set the conversation context window for suggestions",
		handler: async (_args, ctx) => {
			const messages = await ctx.ui.input(
				"Context: number of recent messages",
				String(config.contextMessages),
			);
			if (messages === undefined) return;
			const chars = await ctx.ui.input(
				"Context: chars kept per message",
				String(config.contextChars),
			);
			if (chars === undefined) return;

			const messagesCount = clampInt(Number(messages), 0, 50, config.contextMessages);
			const charsCount = clampInt(Number(chars), 0, 10_000, config.contextChars);
			config.contextMessages = messagesCount;
			config.contextChars = charsCount;
			saveGlobalConfig({ contextMessages: messagesCount, contextChars: charsCount }, ctx);
			ctx.ui.notify(`Suggestion context: ${messagesCount} messages × ${charsCount} chars`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = readConfig(ctx.cwd);
		configureDebug({ enabled: config.debug, logFile: defaultLogFile() });
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new SuggestingEditor(tui, theme, keybindings, ctx, () => config, () => activeTools(pi));
			seedHistoryFromSession(editor, ctx);
			return editor;
		});
	});

	// Suggest a next prompt when the agent finishes and the input box is empty.
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		editor?.onAgentSettled();
	});

	pi.on("before_agent_start", () => {
		editor?.clearGhost();
	});

	pi.on("session_shutdown", () => {
		editor?.dispose();
		editor = null;
	});
}

/**
 * Active tools in the shape the agent sends them (name/description/parameters),
 * so the session-strategy request shares the main loop's cacheable prefix.
 */
function activeTools(pi: ExtensionAPI): Tool[] {
	try {
		const active = pi.getActiveTools();
		const all = new Map(pi.getAllTools().map((t) => [t.name, t]));
		const out: Tool[] = [];
		for (const name of active) {
			const t = all.get(name);
			if (t) out.push({ name: t.name, description: t.description, parameters: t.parameters as Tool["parameters"] });
		}
		return out;
	} catch {
		return [];
	}
}

function whileTypingOrAfterTurn(mode: SuggestMode): boolean {
	return mode !== "off";
}

/**
 * writeGlobalConfig plus a warning when the previous file was unparseable
 * and had to be backed up — config loss must never be silent again.
 */
function saveGlobalConfig(partial: Partial<Config>, ctx: ExtensionContext): void {
	const { backupPath } = writeGlobalConfig(partial);
	if (backupPath) {
		ctx.ui.notify(`Existing config was unreadable; backed up to ${backupPath}`, "warning");
	}
}

function defaultLogFile(): string {
	return path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "prompt-suggestions-zh.log");
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Repopulate the editor's UP-arrow history from the session branch so it
 * survives `/reload` (which reinstantiates the editor with empty history).
 */
function seedHistoryFromSession(editor: SuggestingEditor, ctx: ExtensionContext): void {
	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!("role" in msg) || msg.role !== "user") continue;
		const text = extractTextContent(msg.content).trim();
		if (text) editor.addToHistory(text);
	}
}
