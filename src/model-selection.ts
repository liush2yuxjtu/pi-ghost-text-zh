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

/** Prefer a fast, cheap model for suggestions ("auto" cheap model). */
export const MODEL_PREFERENCES = [/gpt-.*mini/i, /haiku/i, /flash/i, /nano/i, /spark/i];

/** Pick the first pool model matching a preference pattern, else the fallback. */
export function pickAutoModel(
	pool: Model<any>[],
	fallback: Model<any> | undefined,
	exclude: ReadonlySet<string> = new Set(),
): Model<any> | undefined {
	pool = pool.filter((m) => !exclude.has(modelKey(m)));
	// Prefer the same provider as the session model (same auth), then any other
	// available provider that still has a cheap match (e.g. cursor/* when
	// CURSOR_API_KEY is configured, or a local mini/haiku/flash provider).
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
 * ChatGPT account rejects gpt-5.4-mini / gpt-5.3-codex-spark; cursor/* needs a
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
