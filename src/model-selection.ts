/**
 * Suggestion model resolution.
 *
 * Only `import type` from pi packages, so the pure helpers here are
 * unit-testable with plain Node.
 *
 * Strategies (fork change):
 * - "session": reuse the session's current model and send the same system
 *   prompt / tools / message prefix + one extra user turn, so the provider's
 *   prompt cache is hit (what Claude Code and Codex do).
 * - "cheap": a separate small model with a compact standalone digest.
 *
 * @module
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Strategy = "session" | "cheap";

/**
 * Prefer GPT-6 Luna (ChatGPT Codex–compatible) for suggestions ("auto" cheap model).
 * Do not list gpt-*-mini / spark here: ChatGPT-backed openai-codex rejects them.
 * haiku/flash/nano remain for non-Codex providers (e.g. Anthropic / Gemini / cursor).
 */
export const MODEL_PREFERENCES = [/gpt-6-luna/i, /gpt-.*luna/i, /haiku/i, /flash/i, /nano/i];

/** Never auto-pick these on openai-codex (ChatGPT account rejects mini/spark). */
export const CODEX_CHATGPT_DENY = [/gpt-.*mini/i, /spark/i];

function isDeniedOnCodex(m: Pick<Model<any>, "provider" | "id">): boolean {
	if (m.provider !== "openai-codex") return false;
	return CODEX_CHATGPT_DENY.some((p) => p.test(m.id));
}

/** Pick the first pool model matching a preference pattern, else the fallback. */
export function pickAutoModel(
	pool: Model<any>[],
	fallback: Model<any> | undefined,
	exclude: ReadonlySet<string> = new Set(),
): Model<any> | undefined {
	pool = pool.filter((m) => !exclude.has(modelKey(m)) && !isDeniedOnCodex(m));
	// Prefer the same provider as the session model (same auth), then any other
	// available provider that still has a cheap match (e.g. cursor/* when
	// CURSOR_API_KEY is configured, or a local haiku/flash provider).
	const sameProvider = fallback ? pool.filter((m) => m.provider === fallback.provider) : pool;
	const otherProviders = fallback ? pool.filter((m) => m.provider !== fallback.provider) : [];
	for (const candidates of [sameProvider, otherProviders]) {
		for (const pattern of MODEL_PREFERENCES) {
			const match = candidates.find((m) => pattern.test(m.id));
			if (match) return match;
		}
	}
	return fallback;
}

/** Scoped models when scoping is configured, else every available model. */
export function scopedOrAvailable(ctx: ExtensionContext): Model<any>[] {
	const scoped = ctx.scopedModels.map((s) => s.model);
	return scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
}

export function modelKey(m: Pick<Model<any>, "provider" | "id">): string {
	return `${m.provider}/${m.id}`;
}

/**
 * Models that failed for account/auth reasons this process (e.g. Codex with a
 * ChatGPT account rejects gpt-*-mini / spark; cursor/* needs a
 * CURSOR_API_KEY). "auto" skips them and eventually falls back to the session model.
 */
export const unusableModels = new Set<string>();

export function isUnusableModelError(message: string): boolean {
	if (/unsupported parameter/i.test(message)) return false;
	return /not supported|unsupported|not available|does not exist|not found|api key|unauthori[sz]ed|forbidden|permission|\b40[134]\b/i.test(message);
}

export function findModel(pool: Model<any>[], spec: string): Model<any> | undefined {
	return pool.find((m) => `${m.provider}/${m.id}` === spec);
}

export function resolveCheapModel(ctx: ExtensionContext, modelSetting: string): Model<any> | undefined {
	const available = ctx.modelRegistry.getAvailable();
	if (modelSetting !== "auto") return findModel(available, modelSetting) ?? ctx.model;
	return pickAutoModel(available, ctx.model, unusableModels);
}

export interface ResolvedModel {
	model: Model<any>;
	strategy: Strategy;
}

export function resolveSuggestionModel(ctx: ExtensionContext, strategy: Strategy, cheapModel: string): ResolvedModel | undefined {
	if (strategy === "session" && ctx.model) return { model: ctx.model, strategy: "session" };
	const model = resolveCheapModel(ctx, cheapModel);
	return model ? { model, strategy: "cheap" } : undefined;
}
