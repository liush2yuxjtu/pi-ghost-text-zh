/**
 * The ghost-text editor component.
 *
 * Extends pi's CustomEditor and renders suggestions as dim ghost text after
 * the cursor. Owns debounce, in-flight cancellation, streaming, multi-candidate
 * cycling, and a per-turn cost guard.
 *
 * @module
 */

import { buildSessionContext, convertToLlm, CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { Config } from "./config.ts";
import { afterTurnEnabled, whileTypingEnabled } from "./mode.ts";
import {
	isUnusableModelError,
	modelKey,
	resolveCheapModel,
	resolveSuggestionModel,
	unusableModels,
	type Strategy,
} from "./model-selection.ts";
import { buildPromptParts, renderForkPrompt, renderStandalonePrompt, type ContextWindow } from "./context.ts";
import {
	classifyResponse,
	FORK_INSTRUCTIONS,
	GENERATION_TIMEOUT_MS,
	MAX_TOKENS,
	TEMPERATURE,
	systemPromptFor,
} from "./client.ts";
import { lastAssistantUsage, shouldFallbackCold } from "./cache.ts";

interface SuggestionRequest {
	model: Model<any>;
	strategy: Strategy;
	context: Context;
	options: SimpleStreamOptions;
}
import { extractSuggestion, isEligible, parseCandidates } from "./normalize.ts";
import { debug } from "./debug.ts";
import { isCursorAtEnd, renderGhostText } from "./render.ts";

const DEBOUNCE_MS = 700;
const STATUS_KEY = "prompt-suggestions";

export class SuggestingEditor extends CustomEditor {
	private ghost: string | null = null; // visible remainder shown dimmed
	private suggestionFull: string | null = null; // currently shown full suggestion
	private candidates: string[] = []; // all fetched candidates
	private candidateIndex = 0; // which candidate is shown
	private baseText = ""; // editor text the suggestion was generated for
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private abort: AbortController | undefined;
	private requestSeq = 0;
	private hintShown = false;
	private shownThisTurn = 0; // cost/energy guard counter
	private dim: (s: string) => string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly ctx: ExtensionContext,
		private readonly getConfig: () => Config,
		private readonly getTools: () => Tool[] = () => [],
	) {
		super(tui, theme, keybindings);
		this.dim = (s: string) => ctx.ui.theme.fg("dim", s);
	}

	dispose(): void {
		clearTimeout(this.debounceTimer);
		this.abort?.abort();
		this.clearGhost();
		this.ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	/** Agent has settled: reset the per-turn guard and offer a next prompt. */
	onAgentSettled(): void {
		this.shownThisTurn = 0;
		this.suggestIfEmpty();
	}

	suggestIfEmpty(): void {
		if (!afterTurnEnabled(this.getConfig().mode)) return;
		if (this.getText().trim().length !== 0) return;
		void this.requestSuggestion(true);
	}

	clearGhost(): void {
		if (this.ghost === null && this.suggestionFull === null) return;
		this.ghost = null;
		this.suggestionFull = null;
		this.candidates = [];
		this.candidateIndex = 0;
		this.tui.requestRender();
	}

	private cursorAtEnd(): boolean {
		return isCursorAtEnd(this.getLines(), this.getCursor());
	}

	private contextOpts(): ContextWindow {
		const c = this.getConfig();
		return {
			messages: c.contextMessages,
			chars: c.contextChars,
			lastAssistantChars: c.lastAssistantChars,
			toolCalls: c.toolCalls,
		};
	}

	private acceptSuggestion(): void {
		if (!this.suggestionFull) return;
		if (this.baseText) {
			this.insertTextAtCursor(this.suggestionFull.slice(this.baseText.length));
		} else {
			this.setText(this.suggestionFull);
		}
		this.requestSeq++; // ignore any in-flight result
		this.abort?.abort();
		this.clearGhost();
	}

	/** Tab: cycle to the next candidate, else accept. Right arrow accepts directly. */
	private cycleOrAccept(): void {
		if (this.candidates.length > 1) {
			const now = this.getText();
			for (let i = this.candidateIndex + 1; i < this.candidates.length; i++) {
				const candidate = this.candidates[i]!;
				if (!now || candidate.startsWith(now)) {
					this.candidateIndex = i;
					this.baseText = now;
					this.suggestionFull = candidate;
					this.ghost = candidate.slice(now.length);
					this.tui.requestRender();
					return;
				}
			}
		}
		this.acceptSuggestion();
	}

	override handleInput(data: string): void {
		if (this.ghost) {
			if (matchesKey(data, Key.tab) && !this.isShowingAutocomplete()) {
				this.cycleOrAccept();
				return;
			}
			if (matchesKey(data, Key.right) && this.cursorAtEnd()) {
				this.acceptSuggestion();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.clearGhost();
				return;
			}
		}

		const before = this.getText();
		super.handleInput(data);
		const after = this.getText();

		if (after !== before) {
			this.onTextChanged(after);
		} else if (this.ghost && !this.cursorAtEnd()) {
			this.clearGhost();
		}
	}

	private onTextChanged(text: string): void {
		// Shrink the ghost locally while the typed text still prefixes the suggestion.
		if (
			this.suggestionFull &&
			this.baseText &&
			text.startsWith(this.baseText) &&
			this.suggestionFull.startsWith(text)
		) {
			this.baseText = text;
			this.ghost = this.suggestionFull.slice(text.length);
			if (!this.ghost.trim()) {
				this.clearGhost();
			} else {
				this.tui.requestRender();
			}
		} else {
			this.clearGhost();
		}
		this.schedule();
	}

	private schedule(): void {
		clearTimeout(this.debounceTimer);
		this.abort?.abort(); // in-flight result is for stale text
		this.debounceTimer = setTimeout(() => void this.requestSuggestion(false), DEBOUNCE_MS);
	}

	private async requestSuggestion(allowEmpty: boolean): Promise<void> {
		const config = this.getConfig();
		if (allowEmpty ? !afterTurnEnabled(config.mode) : !whileTypingEnabled(config.mode)) return;
		if (!this.ctx.isIdle()) return; // skip while the agent is streaming
		if (config.maxPerTurn > 0 && this.shownThisTurn >= config.maxPerTurn) return;

		const text = this.getText();
		if (!isEligible(text, allowEmpty)) return;

		const resolved = resolveSuggestionModel(this.ctx, config.strategy, config.model);
		if (!resolved) return;

		const seq = ++this.requestSeq;
		const ac = new AbortController();
		this.abort = ac;
		this.ctx.ui.setStatus(STATUS_KEY, "suggesting…");

		try {
			let request = this.buildRequest(resolved.model, resolved.strategy, text, ac.signal, config);
			let suggestions: string[] = [];
			for (let attempt = 0; ; attempt++) {
				try {
					suggestions = await this.generateSuggestions(request, text, ac.signal, config);
					break;
				} catch (err) {
					// Cheap "auto" model rejected for this account: remember it, retry with the next pick
					// (ends at the session model, which always works if the main loop does).
					const message = err instanceof Error ? err.message : String(err);
					if (ac.signal.aborted || attempt >= 6 || request.strategy !== "cheap" || config.model !== "auto" || !isUnusableModelError(message)) throw err;
					unusableModels.add(modelKey(request.model));
					debug("info", `marking ${modelKey(request.model)} unusable: ${message}`);
					const next = resolveCheapModel(this.ctx, config.model);
					if (!next || unusableModels.has(modelKey(next))) throw err;
					request = this.buildRequest(next, "cheap", text, ac.signal, config);
				}
			}
			if (seq !== this.requestSeq || ac.signal.aborted) return;
			this.commitSuggestions(suggestions, text);
		} catch (err) {
			if (seq !== this.requestSeq || ac.signal.aborted) return;
			const message = err instanceof Error ? err.message : String(err);
			const isTimeout = /timeout|timed ?out/i.test(message);
			debug(isTimeout ? "timeout" : "error", message);
			this.clearGhost();
		} finally {
			if (seq === this.requestSeq) {
				this.ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}
	}

	// ── Generation ────────────────────────────────────────────────────────

	/**
	 * Build one suggestion request.
	 *
	 * "session": same model, same system prompt, same tools, same message
	 * prefix and the same sessionId (→ prompt_cache_key) as the main agent
	 * loop, plus one extra user turn with suggestion instructions. Providers
	 * with prefix caching (OpenAI/Codex, Anthropic) then only bill the new
	 * tail as uncached input. Tool calls are disabled via toolChoice "none".
	 * Falls back to "cheap" when the last turn shows a cold cache.
	 *
	 * "cheap": separate small model, standalone compact digest.
	 */
	buildRequest(model: Model<any>, strategy: Strategy, text: string, signal: AbortSignal, config: Config): SuggestionRequest {
		const sm = this.ctx.sessionManager;
		const branch = sm.getBranch();
		const parts = buildPromptParts(branch, this.ctx.cwd, text, this.contextOpts());
		const reasoning = config.reasoning === "off" ? undefined : config.reasoning;
		const base: SimpleStreamOptions = {
			signal,
			maxTokens: MAX_TOKENS,
			timeoutMs: GENERATION_TIMEOUT_MS,
			...(model.reasoning && reasoning ? { reasoning } : {}),
		};

		if (strategy === "session") {
			const usage = lastAssistantUsage(branch);
			if (shouldFallbackCold(usage, config.coldCacheTokens)) {
				debug("info", `cache cold (uncached input ${usage?.input}), using cheap model`);
				const cheap = resolveCheapModel(this.ctx, config.model);
				if (cheap) return this.buildRequest(cheap, "cheap", text, signal, config);
			}
			const full = (sm as unknown as { getEntries(): any[] }).getEntries();
			const sessionCtx = buildSessionContext(full, sm.getLeafId());
			const messages = convertToLlm(sessionCtx.messages);
			messages.push({
				role: "user",
				content: [{ type: "text", text: renderForkPrompt(parts, FORK_INSTRUCTIONS) }],
				timestamp: Date.now(),
			});
			return {
				model,
				strategy,
				context: { systemPrompt: this.ctx.getSystemPrompt(), messages, tools: this.getTools() },
				options: { ...base, sessionId: sm.getSessionId(), toolChoice: "none" },
			};
		}

		return {
			model,
			strategy,
			context: {
				systemPrompt: systemPromptFor(config.candidates),
				messages: [{ role: "user", content: [{ type: "text", text: renderStandalonePrompt(parts) }], timestamp: Date.now() }],
			},
			// Reasoning models (e.g. Codex) reject temperature.
			options: model.reasoning ? base : { ...base, temperature: TEMPERATURE },
		};
	}

	private async generateSuggestions(req: SuggestionRequest, text: string, signal: AbortSignal, config: Config): Promise<string[]> {
		// The session strategy asks for one suggestion (multi-candidate needs a different prompt).
		const count = req.strategy === "session" ? 1 : config.candidates;
		if (count === 1 && config.streaming) {
			try {
				return [await this.streamSingle(req, text, signal)];
			} catch (err) {
				if (signal.aborted) throw err; // interrupted by a newer keystroke, not a stream failure
				const message = err instanceof Error ? err.message : String(err);
				debug("error", `streaming failed, falling back to complete: ${message}`);
				this.clearGhost();
				return this.completeCandidates(req, signal, 1);
			}
		}
		return this.completeCandidates(req, signal, count);
	}

	private logUsage(req: SuggestionRequest, msg: AssistantMessage | undefined, started: number): void {
		const u = msg?.usage;
		debug(
			"info",
			`strategy=${req.strategy} model=${req.model.provider}/${req.model.id} ms=${Date.now() - started}` +
				(u ? ` input=${u.input} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} output=${u.output}` : ""),
		);
	}

	private async streamSingle(req: SuggestionRequest, text: string, signal: AbortSignal): Promise<string> {
		const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(req.model);
		if (!auth.ok) throw new Error(auth.error);
		const started = Date.now();

		const stream = streamSimple(req.model, req.context, {
			...req.options,
			apiKey: auth.apiKey ?? "",
			headers: auth.headers,
			env: auth.env,
		});

		let acc = "";
		let final: AssistantMessage | undefined;
		for await (const event of stream) {
			if (signal.aborted) throw new Error("aborted");
			if (event.type === "text_delta") {
				acc += event.delta;
				this.updateStreamingGhost(acc, text);
			} else if (event.type === "text_end") {
				acc = event.content;
			} else if (event.type === "done") {
				final = event.message;
			} else if (event.type === "error") {
				throw new Error(event.error?.errorMessage ?? event.reason ?? "stream error");
			}
		}
		this.logUsage(req, final, started);
		return acc;
	}

	private async completeCandidates(req: SuggestionRequest, signal: AbortSignal, count: number): Promise<string[]> {
		const started = Date.now();
		const response = await this.ctx.modelRegistry.complete(req.model, req.context, {
			...req.options,
			signal,
			maxTokens: MAX_TOKENS * count,
		});
		this.logUsage(req, response, started);

		const classified = classifyResponse(response);
		if (!classified.ok) {
			if (classified.reason === "error") throw new Error(classified.message ?? "model error");
			debug("no-suggestion", classified.message);
			return [];
		}
		return parseCandidates(classified.text, count);
	}

	/** Show the accumulated text as a partial ghost while streaming. */
	private updateStreamingGhost(acc: string, baseText: string): void {
		if (this.getText() !== baseText) return; // user typed more; ignore this stream
		if (!acc.startsWith(baseText)) return; // model deviated; wait for final validation
		const remainder = acc.slice(baseText.length);
		if (!remainder) return;
		this.baseText = baseText;
		this.suggestionFull = acc;
		this.ghost = remainder;
		this.tui.requestRender();
	}

	// ── Commit ────────────────────────────────────────────────────────────

	private commitSuggestions(raw: string[], text: string): void {
		const now = this.getText();
		const candidates: string[] = [];
		for (const rawCandidate of raw) {
			const suggestion = extractSuggestion(rawCandidate, text);
			if (!suggestion) continue;
			if (now !== text) {
				// The user typed more while the request was in flight.
				if (!now || !suggestion.startsWith(now) || suggestion.length <= now.length) continue;
			}
			if (!candidates.includes(suggestion)) candidates.push(suggestion);
		}

		if (candidates.length === 0) {
			debug("no-suggestion");
			this.clearGhost();
			return;
		}

		const baseText = now !== text ? now : text;
		this.candidates = candidates;
		this.candidateIndex = 0;
		this.baseText = baseText;
		this.suggestionFull = candidates[0]!;
		this.ghost = candidates[0]!.slice(baseText.length);

		if (!this.ghost || !this.cursorAtEnd()) {
			this.clearGhost();
			return;
		}

		this.shownThisTurn++;
		if (!this.hintShown) {
			this.hintShown = true;
			this.ctx.ui.notify("Prompt suggestions: Tab or → to accept, /suggest to configure", "info");
		}
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.ghost) return lines;
		return renderGhostText(lines, width, this.ghost, this.cursorAtEnd(), this.dim);
	}
}
