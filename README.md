# claude-subagent-router

A single local proxy that sits at Claude Code's `ANTHROPIC_BASE_URL`. The main session keeps talking to
Anthropic, while subagent requests can go to Antigravity, OpenCode Zen or OpenCode Go instead.

```
Claude Code
    |  ANTHROPIC_BASE_URL=http://127.0.0.1:3457
    v
router.mjs
    |-- alias or ag/*  -> Antigravity proxy (:8080 by default)
    |-- zen/*          -> OpenCode Zen   (/zen/v1)
    |-- go/*           -> OpenCode Go    (/zen/go/v1)
    |-- everything else -> api.anthropic.com, byte for byte
```

Only requests whose `model` names a routed target leave the Anthropic path. Every other request is forwarded
to `api.anthropic.com` unchanged, including the caller's auth headers, so the main session keeps using the
claude.ai subscription login.

## Routing

| `model` in the request | Where it goes | Wire format |
|---|---|---|
| an alias from `router.json` (default `subagent`) | whatever the alias points to, resolved up to 5 times | as resolved |
| `ag/<model>` | Antigravity proxy, e.g. `ag/gemini-3-flash` | Anthropic Messages, forwarded |
| `zen/<model>` | OpenCode Zen | Anthropic Messages if the model matches `anthropicFormat`, otherwise OpenAI chat completions, translated |
| `go/<model>` | OpenCode Go | same as Zen |
| anything else (`claude-*`, ...) | `api.anthropic.com` | untouched passthrough |

For each provider, `anthropicFormat` lists model patterns served natively at `/messages`. Other models are
sent to `/chat/completions` and translated both ways, including streaming SSE, tool calls, tool results,
images and usage counters. Patterns in `unsupported` are rejected with a clear error because they use the
OpenAI Responses or Google APIs, which the router does not translate.

Aliases are hot-reloaded: edit `aliases.subagent` in `router.json` and the next request uses the new value.
No restart of the router or Claude Code is needed.

## Setup

Requires Node.js 20 or newer (uses global `fetch` and `structuredClone`).

1. Create the local config:

   ```sh
   cp router.example.json router.json
   ```

2. `router.json` supports `${NAME}` and `${NAME:-default}` placeholders in string values. The example reads:

   - `ANTIGRAVITY_URL` (default `http://127.0.0.1:8080`)
   - `OPENCODE_AUTH_FILE` (default `~/.local/share/opencode/auth.json`)

3. API keys are never stored in `router.json`. They are read at request time from `authFile`, using the
   top-level keys named by `providers.<name>.authKey`. That is the auth file written by OpenCode:

   ```json
   {
     "opencode":    { "key": "..." },
     "opencode-go": { "key": "..." }
   }
   ```

4. Start the proxy:

   ```sh
   node router.mjs
   curl http://127.0.0.1:3457/router/health
   ```

5. Point Claude Code at it:

   | Environment variable | Value | Purpose |
   |---|---|---|
   | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:3457` | send all requests through the router |
   | `CLAUDE_CODE_SUBAGENT_MODEL` | `subagent` | use the alias from `router.json` |
   | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | `1` | stop a per-call model from overriding the subagent model and falling back to Anthropic |
   | `ENABLE_TOOL_SEARCH` | `true` | keep tool search on; with a custom base URL Claude Code disables it and loads every tool into each request |

   Do not set `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`; either one replaces the subscription login.

6. Restrict the process to `127.0.0.1` (the code binds loopback). Do not expose it to a network interface:
   the proxy has no authentication and forwards whatever credentials the caller sends.

The `model` field may also be set per call (for example with `opencode run --agent <agent> -m zen/<model>`),
so aliases are optional.

## Logging and capture

`router.log` is JSON Lines. Each line records route, requested model, upstream target, status, timing and,
on failure, the upstream error text. Tokens and auth headers are never logged.

- `"logShapes": true` adds request shape details: tool count, deferred tool count, beta flags, whether the
  session header was present.
- `"captureFile": "<path>"` writes the last routed Claude Code request body for replaying. It contains prompt
  content and is off by default. Both `router.json` and any capture file are gitignored here.

## Limitations

- **Anthropic-only passthrough.** The main session works only because requests to `api.anthropic.com` are
  forwarded unchanged. If you point Anthropic traffic at another backend, that session loses the subscription
  login.
- **No Responses or Google API support.** Models behind those APIs are rejected rather than translated.
- **Tool search is approximated** for non-Anthropic backends. Deferred tools are filtered to those already
  loaded, and `tool_reference` blocks become plain text. A provider that needs the full tool list may behave
  differently from Anthropic.
- **Prompt caching is stripped** for OpenAI-format backends. `cache_control` is removed because the
  translation target has no equivalent.
- **Token counting is an estimate.** `/v1/messages/count_tokens` returns a character-based estimate.
- **Tool calls are buffered** until a stream completes because providers interleave argument chunks
  differently. This delays tool-call delivery but keeps the output well formed.
- **No retries or failover.** Upstream errors are returned to Claude Code; the proxy does not silently switch
  providers.
- **Antigravity may reject Claude Code subagent traffic.** In testing, its backend answered real Claude Code
  subagent requests with `429 RESOURCE_EXHAUSTED` on every Gemini variant while tiny requests to the same
  models passed. The proxy's own source attributes that 429 to system prompts that identify another vendor's
  product. The `ag/` route works for other callers. Repeated 429s also lengthen the proxy's per-model backoff
  (1 min, 5 min, 30 min, 2 h).
- **Remote Control is unavailable** while `ANTHROPIC_BASE_URL` points at a non-Anthropic host.
- **Local trust model.** The listener is loopback-only and unauthenticated. Any local process can use the
  configured upstream credentials through it.
- **Static routing.** There is no model discovery; provider capability lists in `router.json` must match what
  the upstream actually serves. Unknown models fall through to the provider's chat-completions path.

## License

MIT. See `LICENSE`.
