import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectLanguage, languageInstruction } from "../src/language.ts";
import {
	buildPromptParts,
	clip,
	describeToolCall,
	digestMessages,
	projectLabel,
	renderForkPrompt,
	renderStandalonePrompt,
	summarizeToolCalls,
} from "../src/context.ts";
import { lastAssistantUsage, shouldFallbackCold } from "../src/cache.ts";
import { extractSuggestion, normalizeSuggestionText } from "../src/normalize.ts";
import { pickAutoModel, resolveSuggestionModel } from "../src/model-selection.ts";
import { FORK_INSTRUCTIONS, SYSTEM_PROMPT } from "../src/client.ts";

const msg = (role: string, content: unknown, extra: object = {}) => ({ type: "message", message: { role, content, ...extra } });

test("detectLanguage: Chinese conversation with code tokens is zh-Hans", () => {
	assert.equal(detectLanguage(["帮我把 src/index.ts 里的 bug 修一下，然后跑 npm test"]), "zh-Hans");
	assert.equal(detectLanguage(["請幫我修這個問題，然後說明"]), "zh-Hant");
	assert.equal(detectLanguage(["fix the failing test in src/index.ts"]), "en");
	assert.equal(detectLanguage(["テストを実行してください"]), "ja");
	assert.equal(detectLanguage(["테스트를 실행해 주세요"]), "ko");
	assert.equal(detectLanguage(["123 !!!"]), "unknown");
});

test("languageInstruction names the language", () => {
	assert.match(languageInstruction("zh-Hans"), /Simplified Chinese/);
	assert.match(languageInstruction("unknown"), /same language/);
});

test("digest keeps a larger budget for the latest assistant reply", () => {
	const long = "甲".repeat(3000) + "最后问：要不要我提交？";
	const entries = [msg("user", "改一下"), msg("assistant", [{ type: "text", text: "旧回复".repeat(500) }]), msg("user", "继续"), msg("assistant", [{ type: "text", text: long }])];
	const d = digestMessages(entries, { messages: 10, chars: 100, lastAssistantChars: 1000 });
	assert.ok(d.includes("要不要我提交"), "tail of last reply kept");
	const older = d.split("\n\n").find((p) => p.startsWith("Assistant: 旧回复"))!;
	assert.ok(older.length < 200);
});

test("clip keeps head and tail", () => {
	const c = clip("a".repeat(100) + "END", 50);
	assert.ok(c.endsWith("END"));
	assert.ok(c.length <= 52);
});

test("tool call summary", () => {
	const entries = [
		msg("assistant", [{ type: "toolCall", name: "bash", arguments: { command: "npm test\n--silent" } }, { type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } }]),
		msg("toolResult", [{ type: "text", text: "ok" }]),
		msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: "README.md" } }]),
	];
	assert.deepEqual(summarizeToolCalls(entries, 2), ["edit: src/a.ts", "read: README.md"]);
	assert.equal(describeToolCall("bash", { command: "npm test\n--silent" }), "bash: npm test --silent");
	assert.equal(describeToolCall("todo", {}), "todo");
});

test("projectLabel reads package.json name", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "my-pkg" }));
	assert.equal(projectLabel(dir), `${path.basename(dir)} (package: my-pkg)`);
});

test("standalone and fork prompts include project, tools and Chinese instruction", () => {
	const entries = [msg("user", "帮我写个测试"), msg("assistant", [{ type: "text", text: "写好了，要运行吗？" }, { type: "toolCall", name: "write", arguments: { path: "t.test.ts" } }])];
	const parts = buildPromptParts(entries, "/tmp/demo", "", { messages: 8, chars: 500, toolCalls: 5 });
	assert.equal(parts.lang, "zh-Hans");
	const s = renderStandalonePrompt(parts);
	assert.match(s, /Project: demo/);
	assert.match(s, /write: t\.test\.ts/);
	assert.match(s, /Simplified Chinese/);
	assert.match(s, /input box is empty/);
	const f = renderForkPrompt(parts, FORK_INSTRUCTIONS);
	assert.match(f, /SUGGESTION MODE/);
	assert.match(f, /Simplified Chinese/);
	assert.match(SYSTEM_PROMPT, /same language/);
});

test("cold cache fallback", () => {
	const entries = [msg("assistant", [], { usage: { input: 50_000, output: 10, cacheRead: 0, cacheWrite: 0 } })];
	assert.equal(shouldFallbackCold(lastAssistantUsage(entries), 20_000), true);
	assert.equal(shouldFallbackCold({ input: 500, cacheRead: 40_000 }, 20_000), false);
	assert.equal(shouldFallbackCold({ input: 50_000 }, 0), false);
	assert.equal(shouldFallbackCold(undefined, 20_000), false);
});

test("normalize strips CJK labels and quotes", () => {
	assert.equal(normalizeSuggestionText("建议：跑一下测试"), "跑一下测试");
	assert.equal(normalizeSuggestionText("“提交这些改动”"), "提交这些改动");
	assert.equal(normalizeSuggestionText("Suggestion: run the tests"), "run the tests");
	assert.equal(normalizeSuggestionText("NONE"), null);
	assert.equal(extractSuggestion("把测试也跑一下", "把测试"), "把测试也跑一下");
});

test("model strategy selection", () => {
	const m = (provider: string, id: string) => ({ provider, id }) as any;
	const session = m("openai-codex", "gpt-5.6-luna");
	const pool = [m("cursor", "claude-haiku-4-5"), m("openai-codex", "gpt-5.6-luna"), m("openai-codex", "gpt-5.4-mini")];
	assert.equal(pickAutoModel(pool, session)!.id, "gpt-5.4-mini", "same provider cheap model first");
	const ctx = { model: session, modelRegistry: { getAvailable: () => pool } } as any;
	assert.deepEqual(resolveSuggestionModel(ctx, "session", "auto"), { model: session, strategy: "session" });
	assert.equal(resolveSuggestionModel(ctx, "cheap", "auto")!.model.id, "gpt-5.4-mini");
	assert.equal(resolveSuggestionModel(ctx, "cheap", "cursor/claude-haiku-4-5")!.model.id, "claude-haiku-4-5");
});

test("auto cheap model skips models unusable for this account", async () => {
	const { pickAutoModel, isUnusableModelError } = await import("../src/model-selection.ts");
	const m = (provider: string, id: string) => ({ provider, id }) as any;
	const session = m("openai-codex", "gpt-5.6-luna");
	const pool = [m("openai-codex", "gpt-5.4-mini"), m("openai-codex", "gpt-5.3-codex-spark"), session];
	const bad = new Set(["openai-codex/gpt-5.4-mini"]);
	assert.equal(pickAutoModel(pool, session, bad)!.id, "gpt-5.3-codex-spark");
	bad.add("openai-codex/gpt-5.3-codex-spark");
	assert.equal(pickAutoModel(pool, session, bad)!.id, "gpt-5.6-luna", "falls back to session model");
	assert.ok(isUnusableModelError("Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."));
	assert.ok(isUnusableModelError("Cursor SDK runs require a Cursor SDK API key."));
	assert.ok(!isUnusableModelError("request timed out"));
	assert.ok(!isUnusableModelError("Codex error: Unsupported parameter: temperature"));
});
