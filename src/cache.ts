/**
 * Prompt-cache heuristics for the "session" strategy. Pure, no pi imports.
 *
 * Claude Code skips its suggestion when the last main-loop response shows a
 * cold cache (lots of uncached input), because re-sending the full prefix
 * would then be expensive. We fall back to the cheap model instead.
 *
 * @module
 */

export interface UsageLike {
	input: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Usage of the most recent assistant message on the branch, if any. */
export function lastAssistantUsage(entries: readonly unknown[]): UsageLike | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; message?: { role?: string; usage?: UsageLike } };
		if (e?.type === "message" && e.message?.role === "assistant") return e.message.usage;
	}
	return undefined;
}

export function shouldFallbackCold(usage: UsageLike | undefined, threshold: number): boolean {
	if (threshold <= 0 || !usage) return false;
	return (usage.input ?? 0) > threshold;
}
