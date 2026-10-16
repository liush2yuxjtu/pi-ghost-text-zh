/**
 * Scoped config for prompt suggestions.
 *
 * Resolved as `defaults <- global <- project`:
 * - global:  ~/.pi/agent/prompt-suggestions-zh.json
 * - project: .pi/prompt-suggestions-zh.json
 * (separate file names from upstream pi-ghost-text so both can coexist)
 *
 * @module
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonFile, updateJsonFile } from "./json-file.ts";
import { isMode, type SuggestMode } from "./mode.ts";
import type { Strategy } from "./model-selection.ts";

export type Reasoning = "off" | "minimal" | "low" | "medium" | "high";
const REASONING = ["off", "minimal", "low", "medium", "high"];

export type { SuggestMode } from "./mode.ts";

export interface Config {
	/**
	 * "session" = reuse the session model + same prompt prefix (prompt cache hit),
	 * "cheap" = separate small model with a compact digest.
	 */
	strategy: Strategy;
	/** Cheap-strategy model: "auto" = fast model (same provider first), or "provider/model-id". */
	model: string;
	/** Session strategy: fall back to the cheap model when the last turn's uncached input exceeds this many tokens (0 = never). */
	coldCacheTokens: number;
	/** Reasoning effort for suggestion requests. */
	reasoning: Reasoning;
	/** Chars kept for the most recent assistant reply (cheap strategy digest). */
	lastAssistantChars: number;
	/** Recent tool calls summarized in the cheap-strategy digest. */
	toolCalls: number;
	/** Which suggestion behaviors are active. */
	mode: SuggestMode;
	/** Number of alternative suggestions to fetch (1..3). */
	candidates: number;
	/** Stream the single suggestion token-by-token (only when candidates === 1). */
	streaming: boolean;
	/** Number of recent messages included in the suggestion context. */
	contextMessages: number;
	/** Chars kept per message in the suggestion context. */
	contextChars: number;
	/** Max suggestions shown per agent turn (0 = unlimited). */
	maxPerTurn: number;
	/** Append debug lines to ~/.pi/agent/prompt-suggestions-zh.log. */
	debug: boolean;
}

export const DEFAULT_CONFIG: Config = {
	strategy: "session",
	model: "auto",
	coldCacheTokens: 20_000,
	reasoning: "minimal",
	lastAssistantChars: 2_000,
	toolCalls: 8,
	mode: "both",
	candidates: 1,
	streaming: true,
	contextMessages: 10,
	contextChars: 800,
	maxPerTurn: 0,
	debug: false,
};

function clampInt(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

export function globalConfigPath(): string {
	return path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "prompt-suggestions-zh.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "prompt-suggestions-zh.json");
}

export function readConfig(cwd: string): Config {
	const merged: Config = { ...DEFAULT_CONFIG };
	let modeSeen = false;
	let legacyEnabled: boolean | undefined;

	for (const filePath of [globalConfigPath(), projectConfigPath(cwd)]) {
		const read = readJsonFile(filePath);
		if (read.status !== "ok") continue;
		const raw = read.value;
		if (typeof raw.model === "string" && raw.model) merged.model = raw.model;
		if (raw.strategy === "session" || raw.strategy === "cheap") merged.strategy = raw.strategy;
		if (typeof raw.coldCacheTokens !== "undefined") merged.coldCacheTokens = clampInt(raw.coldCacheTokens, 0, 10_000_000);
		if (typeof raw.reasoning === "string" && REASONING.includes(raw.reasoning)) merged.reasoning = raw.reasoning as Reasoning;
		if (typeof raw.lastAssistantChars !== "undefined") merged.lastAssistantChars = clampInt(raw.lastAssistantChars, 0, 20_000);
		if (typeof raw.toolCalls !== "undefined") merged.toolCalls = clampInt(raw.toolCalls, 0, 50);
		if (typeof raw.mode === "string" && isMode(raw.mode)) {
			merged.mode = raw.mode;
			modeSeen = true;
		}
		if (typeof raw.candidates !== "undefined") merged.candidates = clampInt(raw.candidates, 1, 3);
		if (typeof raw.streaming === "boolean") merged.streaming = raw.streaming;
		if (typeof raw.contextMessages !== "undefined") {
			merged.contextMessages = clampInt(raw.contextMessages, 0, 50);
		}
		if (typeof raw.contextChars !== "undefined") {
			merged.contextChars = clampInt(raw.contextChars, 0, 10_000);
		}
		if (typeof raw.maxPerTurn !== "undefined") {
			merged.maxPerTurn = clampInt(raw.maxPerTurn, 0, 1_000);
		}
		if (typeof raw.debug === "boolean") merged.debug = raw.debug;
		if (typeof raw.enabled === "boolean") legacyEnabled = raw.enabled;
	}

	// Legacy migration: before `mode` existed, `enabled: false` meant off.
	if (!modeSeen) merged.mode = legacyEnabled === false ? "off" : "both";
	return merged;
}

/**
 * Merge a partial config into the global config file, preserving keys not
 * in `partial`. Returns a backup path when the previous file existed but
 * was unparseable (its contents are preserved there, not destroyed).
 */
export function writeGlobalConfig(partial: Partial<Config>): { backupPath?: string } {
	return updateJsonFile(globalConfigPath(), partial, { deleteKeys: ["enabled"] });
}
