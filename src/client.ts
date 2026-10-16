/**
 * Suggestion model client — prompt and completion options, plus response
 * classification.
 *
 * Only `import type` from pi packages, so `classifyResponse` is testable
 * with plain Node.
 *
 * @module
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

export const GENERATION_TIMEOUT_MS = 20_000;
export const MAX_TOKENS = 400;
export const TEMPERATURE = 0.3;

export const SYSTEM_PROMPT = `You complete prompts in an AI coding assistant's input box, like ghost-text autocomplete.

Given the project, recent tool activity, the recent conversation and the text the user has typed so far, predict the full prompt the user is most likely to submit next.

Rules:
- Predict what THE USER would type, in the user's voice — not what the assistant would say ("Let me…", "I'll…" are wrong).
- Output ONLY the predicted prompt text. No quotes, no explanation, no markdown, no "Suggestion:" label.
- Write in the same language as the user's recent messages (a Chinese conversation gets a Chinese suggestion).
- If partial input is provided, your output MUST begin with that exact text, unchanged.
- Keep it short: one line, at most two sentences.
- Be specific to the conversation. Prefer concrete next steps (run the tests, commit, fix the file just discussed, pick the option the assistant offered) over generic requests. No thanks / praise.
- If there is no confident prediction, output exactly: NONE`;

/**
 * Instructions appended as an extra user turn when the suggestion request
 * reuses the main session's model, system prompt, tools and message prefix
 * (prompt-cache friendly). Same idea as Claude Code's "[SUGGESTION MODE …]"
 * fork and Codex's hidden ephemeral thread fork; wording is our own.
 */
export const FORK_INSTRUCTIONS = `[SUGGESTION MODE — app-generated request, the user did not write this message. Do not call tools. Do not continue the task.]
Predict the next message the user is most likely to type into the input box, based on the whole conversation above. It will be shown as dim ghost text; the user may accept it with Tab, edit it, or ignore it.
- Write it in the user's voice, as they would phrase it — not as the assistant.
- One line, at most two sentences, concrete (e.g. run the tests, commit this, pick the option you offered, fix the error just shown).
- No thanks/praise, no questions about unrelated topics, no new ideas the user didn't ask for.
- Reply with ONLY the suggestion text, no quotes or labels. If the next step is not obvious, reply exactly: NONE`;

export type ResponseClass =
	| { ok: true; text: string }
	| { ok: false; reason: "error" | "no-content" | "no-text"; message?: string };

/**
 * Classify a completion response into usable suggestion text or a structured
 * failure reason. Extracts only visible text content.
 */
export function classifyResponse(response: AssistantMessage): ResponseClass {
	if (response.stopReason === "error") {
		return { ok: false, reason: "error", message: response.errorMessage ?? response.stopReason };
	}
	if (!response.content || response.content.length === 0) {
		return { ok: false, reason: "no-content" };
	}
	const text = response.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
	if (!text.trim()) {
		return { ok: false, reason: "no-text" };
	}
	return { ok: true, text };
}

/** System prompt for one suggestion, or for several delimited alternatives. */
export function systemPromptFor(candidates: number): string {
	if (candidates <= 1) return SYSTEM_PROMPT;
	return `${SYSTEM_PROMPT}

Additional instruction: provide ${candidates} clearly DIFFERENT alternatives. Output each alternative with no numbering or bullets, separated by a line containing only "---". Each alternative must independently satisfy all the rules above.`;
}
