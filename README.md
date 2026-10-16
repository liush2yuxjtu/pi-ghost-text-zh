# pi-ghost-text-zh

Fork of [pi-ghost-text](https://github.com/jcv/pi-ghost-text) 0.1.2 by **Chris Vaughan** (MIT, see LICENSE). All credit for the editor, ghost rendering, streaming and config plumbing goes to the original.

> **Audience:** not Chinese-only. Suggestions follow the conversation language (zh-Hans / zh-Hant / ja / ko / en). Demo gallery and product copy are bilingual (EN + ZH) with a locale switch.

## Install

```bash
pi install git:github.com/liush2yuxjtu/pi-ghost-text-zh
# or from a local checkout:
# pi install ./pi-ghost-text-zh
```

Config: `~/.pi/agent/prompt-suggestions-zh.json` (and project `.pi/prompt-suggestions-zh.json`).

```json
{ "strategy": "cheap", "model": "openai-codex/gpt-6-luna", "reasoning": "off", "debug": false }
```

- `strategy: "session"` — reuse session model + prompt cache (default).
- `strategy: "cheap"` — separate small model. `model: "auto"` prefers `gpt-6-luna` / `gpt-*luna` on openai-codex first (ChatGPT accounts reject `gpt-*-mini` / spark — those are never auto-picked on that provider), then haiku/flash/nano on other providers (e.g. `cursor/*` when `CURSOR_API_KEY` is set).
- `reasoning: "off" | "minimal" | …` — prefer `"off"` for suggestion latency / demos.

## What this fork changes



- **Language-matched suggestions**: the user's recent messages are script-detected (zh-Hans / zh-Hant / ja / ko / en); a Chinese conversation gets a Chinese next-prompt suggestion.
- **Richer context** (cheap strategy): last assistant reply keeps up to `lastAssistantChars` (default 2000, head+tail), cwd + project name (dir + package.json name), and a one-line summary of the last `toolCalls` (default 8) tool calls.
- **Model strategy** (`strategy`, `/suggest-strategy`):
  - `session` (default): same model as the session, same system prompt, same active tools, same message prefix and same `sessionId` (→ OpenAI `prompt_cache_key`) as the main loop, plus one extra `[SUGGESTION MODE …]` user turn with `toolChoice: "none"`. This mirrors Claude Code (forked query with `cacheSafeParams`) and Codex 0.158 (`tui.prompt_suggestions`, ephemeral thread fork on the parent model). If the last turn's uncached input exceeds `coldCacheTokens` (default 20000) it falls back to the cheap model.
  - `cheap`: a separate model (`model`: `auto` picks `gpt-6-luna` on openai-codex first; e.g. `openai-codex/gpt-6-luna`).
- `reasoning` (default `minimal`) for suggestion requests.
- Config files: `~/.pi/agent/prompt-suggestions-zh.json`, `.pi/prompt-suggestions-zh.json`; debug log `~/.pi/agent/prompt-suggestions-zh.log` (logs strategy, model, latency, input/cacheRead tokens).

Example config:

```json
{ "strategy": "cheap", "model": "openai-codex/gpt-6-luna", "reasoning": "off", "debug": true }
```

Tests: `node --test test/*.test.ts`.

---

## Original README

# pi-ghost-text

Ghost-text prompt suggestions for the [pi coding agent](https://github.com/earendil-works/pi) — like Claude Code's inline autocomplete for the prompt box.

As you type (or after the agent finishes and the input is empty), a dimmed prediction of the likely next prompt appears after the cursor. Accept it, cycle alternatives, or keep typing.

## Requirements

- **Interactive TUI mode.** Suggestions are an editor feature and only appear in the interactive terminal (`pi` with no mode flag). They do not run in `-p`/`--print`, `--mode json`, or `--mode rpc`.
- **A model with a configured API key.** With the default `"model": "auto"`, the extension scans the available models for a fast/cheap one, in priority order: `gpt-6-luna` / `gpt-*luna`, then `haiku`, then `flash`, then `nano` (never `gpt-*-mini` / spark on openai-codex). If none match — or if an explicit `provider/model-id` isn't found — it falls back to the active session model. Set a specific model with `/suggest-model`.

## Install

```bash
pi install npm:pi-ghost-text
```

Remove it:

```bash
pi remove npm:pi-ghost-text
```

## Using it

| Key | Action |
|-----|--------|
| `Tab` | Cycle to the next candidate; accept when it's the last (or only) one |
| `→` (right arrow, cursor at end) | Accept the current suggestion |
| `Esc` | Dismiss the ghost, keeping what you've typed |
| Move the cursor away from the end | Dismiss |
| Keep typing | Shrink the ghost while it still matches, otherwise regenerate |

`Tab` only applies to the ghost when the file/command autocomplete dropdown is **not** open. Accepting inserts the suggestion into the editor for you to edit; press `Enter` to send it.

When `candidates` is `1` (the default), `Tab` simply accepts. Set `candidates` to `2` or `3` to fetch alternatives and cycle them.

## Commands

| Command | What it does |
|---------|--------------|
| `/suggest` | Choose mode: `both`, `while-typing`, `after-turn`, or `off` |
| `/suggest-model` | Pick the suggestion model (or `auto` to prefer a fast, cheap one) |
| `/suggest-context` | Set the context window (messages × chars per message) |

## Configuration

Stored as JSON, resolved `defaults ← global ← project`:

- global: `~/.pi/agent/prompt-suggestions.json`
- project: `.pi/prompt-suggestions.json`

```json
{
  "model": "auto",
  "mode": "both",
  "candidates": 1,
  "streaming": true,
  "contextMessages": 8,
  "contextChars": 600,
  "maxPerTurn": 0,
  "debug": false
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `model` | `"auto"` | `"auto"` (prefer a fast, cheap model) or an explicit `provider/model-id` |
| `mode` | `"both"` | `"both"`, `"while-typing"`, `"after-turn"`, or `"off"` |
| `candidates` | `1` | Alternatives to fetch (1–3); `Tab` cycles them |
| `streaming` | `true` | Stream the single suggestion token-by-token (ignored when `candidates > 1`) |
| `contextMessages` | `8` | Recent messages included in the suggestion prompt (`0` = none) |
| `contextChars` | `600` | Chars kept per message |
| `maxPerTurn` | `0` | Max suggestions shown per agent turn (`0` = unlimited) |
| `debug` | `false` | Append diagnostic lines to `~/.pi/agent/prompt-suggestions.log` |

`mode`, `model`, `contextMessages`, and `contextChars` are settable from the commands above; `candidates`, `streaming`, `maxPerTurn`, and `debug` are JSON-only. Commands write to the **global** scope, so a project override in `.pi/prompt-suggestions.json` takes precedence over a command-set value.

## Privacy

When enabled, the suggestion model receives only:

- the text you have typed so far, and
- the last `contextMessages` user/assistant messages, each trimmed to `contextChars` characters.

It is **never** sent:

- the full conversation transcript,
- tool outputs,
- file contents,
- project or session metadata.

Suggestions are advisory and best-effort; failures are never surfaced in the UI. With `"debug": true` they are logged to `~/.pi/agent/prompt-suggestions.log` with a stable category (`timeout` / `error` / `no-suggestion`).

## Troubleshooting

If no suggestion appears:

1. Confirm the mode is not `off` — run `/suggest`.
2. Confirm the suggestion model has an API key configured (or, for `auto`, that one of the fast/cheap models does). `/suggest-model` shows what's available. An explicit `model` that isn't found silently falls back to the active session model, so check the spelling as `provider/model-id`.
3. **While-typing suggestions** need ≥4 chars of plain text (not starting with `/` or `!`, not an `@file` completion in progress), a ~700ms pause, and the agent must be idle (not mid-response).
4. **After-turn suggestions** only appear when the editor is empty right after the agent settles.
5. If `maxPerTurn` is set, you may have hit the per-turn cap.
6. Set `"debug": true` and check `~/.pi/agent/prompt-suggestions.log` for `[prompt-suggestions]` lines — they state the reason (`timeout`, `error`, `no-suggestion`).
7. If the ghost flakes with streaming enabled, set `"streaming": false` to force the non-streaming path.

## Development

```bash
npm ci --ignore-scripts
npm test   # node --test (requires Node ≥ 23.6)
```

The rendering regression tests use the real `Editor` from the `@earendil-works/pi-tui` peer dependency, pinned by the committed `package-lock.json`.

## Prior art

Inspired by [supi-prompt-suggestions](https://pi.dev/packages/@mrclrchtr/supi-prompt-suggestions?name=supi). This adds inline while-typing autocomplete (prefix-anchored, shrink-on-type), multi-candidate cycling, streaming ghost text, scoped global/project config, and explicit modes on top of the empty-box next-prompt suggestion.
