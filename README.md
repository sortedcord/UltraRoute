# UltraRoute — Production AI Web Frontend Adapters

UltraRoute provides production-grade, web-session-backed adapters for three authenticated AI web interfaces:

1. **ChatGPT Web** (`chatgpt.com`)
2. **Claude Web** (`claude.ai`)
3. **Gemini Web** (`gemini.google.com`)

UltraRoute separates web credentials, provider-specific request execution, protocol decoding, and downstream response conversion. ChatGPT execution uses an authenticated first-party Chromium page; it does not solve security challenges or emulate browser fingerprints.

---

## 1. Quick Start

### Installation

```bash
npm install
npm run build
npm test
```

### Running Unit Tests

Unit tests run with fixture data and require zero live credentials or browser automation:

```bash
npm test
```

Local browser integration uses fabricated protocol data and blocks outbound traffic through fulfilled Playwright routes:

```bash
RUN_BROWSER_TESTS=1 npm run test:integration
```

This requires system Chromium or a Playwright browser installation; it does not read cookies or require a live account. Verified: 87 unit tests and 4 local Chromium scenarios passed; `format:check` and `typecheck` passed. Earlier `build:client` and React visual checks passed against generated UI SSE and a sanitized challenge response. A profile-backed adapter smoke completed two native fixture turns and preserved browser local storage between turns.

### Running Opt-In Live Integration Tests

Live tests are opt-in: set `RUN_LIVE_TESTS=1`. Chromium-profile tests also require `RUN_PROFILE_TESTS=1`; the ordinary integration command does not enable either flag. CI never reads the operator profile by default.

```bash
RUN_LIVE_TESTS=1 \
CHATGPT_COOKIE_HEADER="__Secure-next-auth.session-token=..." \
CLAUDE_SESSION_KEY="sk-ant-sid01-..." \
GEMINI_COOKIE="__Secure-1PSID=...; SAPISID=..." \
npm run test:integration
```

---

## 2. Architecture & Shared Abstractions

All web-session-backed adapters inherit from a unified contract (`IWebSessionProvider` / `BaseWebProviderAdapter`) located in `src/shared/`:

- **Credential & Security Boundary (`src/shared/sanitizer.ts`)**:
  - Enforces automatic redaction of session cookies (`__Secure-*`, `sessionKey`, `SAPISID`, etc.), bearer tokens, and internal UUIDs across error messages, logs, and telemetry.
- **Error Classification (`src/shared/errors.ts`)**:
  - Categorizes failures into `CREDENTIAL_FAILURE` (401), `INVALID_REQUEST` (400), `RATE_LIMIT_EXCEEDED` (429), `UPSTREAM_DRIFT` (502), `CHALLENGE_REQUIRED` (403), `TIMEOUT` (504), and `GENERIC_UPSTREAM_FAILURE` (502).
- **Attachment Validator (`src/shared/attachmentValidator.ts`)**:
  - Validates attachment count, total bytes, permitted MIME types, image dimensions, and prevents SSRF by blocking loopback, link-local, and private RFC-1918 IP addresses.
- **Account-Scoped Continuation Cache (`src/shared/continuationCache.ts`)**:
  - Manages multi-turn state with SHA-256 canonical transcript hashing scoped strictly by account credential, organization, and model. Prevents cross-account session contamination. State is committed _only_ upon successful turn completion.
- **SSE Stream Decoder (`src/shared/sseDecoder.ts`)**:
  - Decodes raw wire chunks across multi-line payloads and split chunk boundaries.
- **Model & Provider Registries (`src/registry/`)**:
  - Global registries for model alias resolution, capability negotiation, and provider lookup.

---

## 3. Provider Details

### 3.1 ChatGPT Web (`chatgpt-web`)

- **Authentication & Security Enclosure**:
  - Accepts raw Cookie headers or Playwright-compatible storage states.
  - Enforces domain boundaries: cookies must belong to `.chatgpt.com` or `.openai.com`, and storage origins must be `https://chatgpt.com` or `https://openai.com`. Foreign origins are rejected.
- **Browser Execution**:
  - The server registers a real Playwright browser factory; an unconfigured adapter fails with 503 instead of returning a mock answer.
  - Each turn gets a fresh context and a temporary-chat page. Normal composer/model controls let first-party code own authentication and request state; the adapter captures conversation SSE rather than scraping rendered answers.
  - The optional `CHATGPT_WEB_EXECUTION=module` path discovers first-party ESM exports. It fails closed if module shape/CSP changes; it never disables CSP. Current observed Rspack bundles do not satisfy the recon module contract.
- **Transport & Completion**:
  - Direct `/backend-api/f/conversation` SSE and WebSocket topic handoffs are separate from assistant decoding. Topic IDs, resume tokens, and conversation IDs stay inside the adapter.
  - Browser turns currently buffer upstream. Downstream UI SSE is supported, but this is **not incremental token streaming**; capabilities advertise `supportsStreaming: false`.
  - Completion requires a final assistant message with `status: finished_successfully` **and** `end_turn: true`; `[DONE]` alone cannot turn a truncated response into success.
- **Attachments**:
  - Shared byte/data-URL/image/file inputs are validated before browser delivery; remote downloads use public-address DNS pinning, byte bounds, MIME/dimension checks, and no redirects or session credentials.
  - Remote image content parts need explicit attachment MIME metadata. Audio and arbitrary native third-party tool calls are rejected rather than silently ignored.

### ChatGPT server setup

```bash
# Explicit supplied state is preferred; file is reread per web request.
CHATGPT_STORAGE_STATE_FILE=/secure/path/chatgpt-state.json \
CHATGPT_CHROMIUM_PATH=/usr/bin/chromium \
npm run server

# Alternatively supply CHATGPT_COOKIE_HEADER through a protected environment.
# Placeholders only: __Secure-next-auth.session-token=REPLACE_ME
```

`CHATGPT_STORAGE_STATE_FILE` takes precedence over `CHATGPT_COOKIE_HEADER`. Without either, the existing local Chromium credential reader is used. Cookie domains, paths, expiry, security, and host-only prefixes are preserved; OpenAI-host cookies are not flattened onto ChatGPT requests. Credentials are refreshed per request and never printed. Headed Chromium uses the existing `DISPLAY`; `CHATGPT_WEB_HEADLESS=1` explicitly selects headless mode. No login/MFA automation is provided.

#### Manual verification with a dedicated profile

Cookie import does not copy the ordinary browser's local storage or complete profile state. Use a dedicated persistent profile when manual verification must carry into later requests:

```bash
export CHATGPT_BROWSER_PROFILE="$HOME/.local/share/ultraroute/chatgpt-profile"
export CHATGPT_CHROMIUM_PATH=/usr/bin/chromium
npm run chatgpt:session
# Authenticate/complete verification yourself, then close the opened browser.
npm run server
```

The preparation command launches ordinary system Chromium and attaches through a loopback-only debugging endpoint; it does not supply Playwright's automation-launch defaults, patch browser fingerprints, submit prompts, enter passwords, handle MFA, or solve verification. Chromium retains the profile locally without exporting credentials. `CHATGPT_BROWSER_PROFILE` takes precedence over cookie/state-file import. Protect this directory as a bearer secret; the adapter sets owner-only directory permissions. Never share one profile between accounts or point it at the ordinary Chromium directory/its ancestors. One request owns the profile at a time; concurrent acquisition fails with 503 rather than mixing account state. Close the preparation window before requesting inference. Local CDP provides full control of that browser; do not expose the port or tunnel it publicly.

Execution still opens a fresh temporary-chat page and closes its context after the turn; only browser session state persists. No transcript continuation cache is added. A 403 is still a stop condition, not an instruction to retry automatically. Profile mode is a state-preservation mechanism, **not proof that the live 403 is resolved**.

Cancellation uses one turn-wide deadline: it closes only the execution page, interrupts native controls and hanging response reads, and cannot continue to Send after cancellation. The manual preparation context is separate. Page-local observation clones only the successful first-party conversation response, reads bounded bytes with fatal streaming UTF-8 decoding, and leaves the frontend's original response unchanged. It never reads login traffic, request bodies, cookies or authorization headers. The capture branch is capped before accumulating more than 16 MiB; browser-internal buffering of the original response remains owned by Chromium. A native AbortError is accepted only when the decoder validates an already completed assistant turn; incomplete responses remain errors.

The React client sends both model and provider. Static SDK/ChatGPT entries resolve through `ModelRegistry`; Claude Web and Gemini Web use their discovered catalogs, and explicit mismatches/unknown models are rejected. A Google API key no longer captures ChatGPT/Claude requests. Explicit `provider: google` selects the Gemini SDK; `provider: gemini-web` selects browser-session transport. Web completions are converted using the installed AI SDK UI-message SSE helpers, including reasoning/tool-call states and sanitized errors—not legacy `0:`/`d:` data frames.

### Upstream research and operational limits

Based on OmniRoute clone `dbe703a0000b303cd7b1cf5879cb8740e5bfce71`:

- [Issue #8813](https://github.com/diegosouzapw/OmniRoute/issues/8813): Sentinel/Turnstile rejection; cookie-only HTTP is insufficient.
- [Issue #14773](https://github.com/diegosouzapw/OmniRoute/issues/14773) and [PR #14819](https://github.com/diegosouzapw/OmniRoute/pull/14819): capture CSP/asset/module failure reasons. UltraRoute additionally bounds loading, cleans listeners, and exposes only allowlisted diagnostic categories/statuses.
- [PR #14948](https://github.com/diegosouzapw/OmniRoute/pull/14948) is **open**, not treated as merged behavior. It describes composer-driven bounded turns and prompt-emulated tools. UltraRoute adopts ordinary first-party UI execution, not tool emulation or corrective retries.
- [Issue #14486](https://github.com/diegosouzapw/OmniRoute/issues/14486): unauthenticated CDP exposure. UltraRoute launches isolated contexts; it adds no public CDP proxy.

Earlier Playwright-launched/imported sessions received upstream **403** on login or conversation requests. A fresh profile authenticated manually in ordinary system Chromium subsequently completed a native temporary-chat turn: preparation **200**, conversation **200 SSE**, displayed answer **4**. Its standard `navigator.webdriver` was false without any patches. This is evidence for using normal Chromium/profile execution, not proof of which upstream check caused the earlier 403. CDP response-body retrieval failed for the successful native stream; browser-page stream capture is used instead. No CAPTCHA or challenge bypass is included.

Likely maintenance points: composer/model/effort/upload selectors in `composer.ts`, first-party module semantic markers and asset paths in `firstParty.ts`, temporary-chat routes/timeouts/model labels in `constants.ts`, handoff event/topic envelopes in `transport.ts`, Delta V1 framing/terminal semantics in `deltaV1.ts`.

Ported first-party/attachment/topic code retains OmniRoute's MIT copyright/license notices (2026 diegosouzapw).

### 3.2 Claude Web (`claude-web`)

- **Authentication & Organization Discovery**:
  - Accepts session cookies (`sessionKey=...`). Automatically normalizes session formats and discovers active organization IDs when not provided.
- **Upstream Model Discovery**:
  - `ClaudeWebAdapter.discoverModels(credentials, signal?)` fetches the authenticated frontend bootstrap at `/edge-api/bootstrap/{organizationId}/app_start`. It reads the `chat` entry of `model_selector_config`, preserving upstream IDs, names, capabilities, main/overflow ordering, and account-specific disabled/upgrade metadata. Deprecated entries are excluded, matching the visible Claude model picker.
  - The server exposes `GET /api/providers/claude-web/models` using its existing Chromium credentials. UltraRoute loads this catalog on page mount, keeps paywalled models visible with upstream plan badges, and disables selection for unavailable models. Discovery errors are shown rather than replaced with a stale hardcoded list; reload the page after changing account or plan.
  - Claude has no static registry entries or legacy model aliases. Send the exact discovered ID with `provider: "claude-web"`; execution fetches the current account catalog and rejects unknown or disabled IDs instead of silently using another model.
  - Verified against Claude's live Free-plan picker: 12 visible main/overflow models, including locked Fable/Opus entries; two deprecated entries excluded. Live discovery and UltraRoute's picker matched, including Sonnet 5.5 selection and upgrade labels. ChatGPT discovery is unchanged.
- **Stateful Continuation & Account Scoping**:
  - Claude Web requires stateful conversations (`parent_message_uuid`).
  - UltraRoute caches continuation state keyed by account scope and transcript hash. Turning state is committed only after an upstream turn successfully completes.
- **SSE Stream Decoding & Idle Finish (#14711)**:
  - Decodes `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop`.
  - Supports reasoning/thinking deltas (`thinking_delta`) and tool calls (`tool_use`).
  - **Tool Idle Finish**: In Claude's web interface, turns involving `tool_use` often stay open with keepalive pings while awaiting browser execution. UltraRoute synthesizes `finish_reason: "tool_calls"` after a configurable idle window (default 3,000ms), unblocking downstream agents to execute tools and continue the conversation.

### 3.3 Gemini Web (`gemini-web`)

- **Authentication & Cookie Sources**:
  - Accepts `__Secure-1PSID` and `SAPISID` cookies. Automatically generates required `SAPISIDHASH` authorization headers.
  - Integrates with the **AuthoCookie sidecar pattern**: `FileCookieSource` checks file `mtime` and reloads updated cookies atomically upon rotation.
  - Discovery requires Chromium: set `GEMINI_CHROMIUM_PATH`, use `/usr/bin/chromium`, or install a Playwright browser (`npx playwright install chromium`). It opens an authenticated Gemini page using the supplied cookies; operators must resolve authentication or security challenges themselves.
- **Upstream Model Discovery**:
  - Gemini Web reads authenticated upstream `GetUserStatus` RPC `otAQ7b` and the actual first-party model picker to obtain account-specific names and availability, rather than assuming every model is enabled from RPC metadata alone.
  - `GET /api/providers/gemini-web/models` returns the current catalog with `Cache-Control: no-store`. UltraRoute loads Gemini Web and Claude catalogs independently on page mount: each has its own loading/error message, and one discovery failure does not remove the other's successful catalog. Disabled Gemini models remain visible with upstream availability text but cannot be selected; reload after changing account or plan.
  - Model IDs are opaque `gemini-web:${upstreamId}` values. Send the exact discovered ID with `provider: "gemini-web"`; there are no legacy aliases or static Gemini Web registry entries. The Google API-key SDK path remains separate (`provider: "google"`) and keeps its SDK model IDs.
- **RPC Protocol (`GeminiRpcDecoder`)**:
  - Decodes Google's length-prefixed `wrb.fr` RPC envelopes and strips `)]}'\n` anti-XSSI prefixes.
  - Extracts generated assistant text, continuation tokens (`conversationId`, `responseId`, `choiceId`), and model category routing.
- **Streaming vs. Continuation Preservation**:
  - Stateless generation streams incrementally, while stateful continuation paths buffer the complete upstream response before returning. UltraRoute preserves this distinction and does not falsely advertise token streaming on buffered stateful paths.

---

## 4. Known Limitations & Intentionally Unsupported Features

1. **Anti-Bot / CAPTCHA Solvers**:
   - UltraRoute intentionally does **not** include Cloudflare Turnstile bypasses, CAPTCHA solvers, or stealth fingerprint evasion hacks.
   - If an account is presented with a security verification challenge, UltraRoute returns a `CHALLENGE_REQUIRED` (403) provider error. Operator resolution in a real browser is required.
2. **Automated Login Flows**:
   - No automated Google, OpenAI, or Anthropic password entry or MFA workflows are implemented. Credentials are provided out-of-band by the operator.
3. **Gemini Stateful Streaming**:
   - Native continuation in Gemini Web buffers the answer upstream; incremental token streaming is unsupported for continued conversations until Google supports it.

---

## 5. Diagnosing Frontend Drift

Provider-specific protocol constants live in `constants.ts`. Claude's model catalog comes from upstream; its bootstrap parser lives in `src/providers/claude/models.ts` and the live transport in `src/providers/claude/transport.ts`.

| Provider        | File                                 | Drift-Sensitive Constants                                                                                                                          |
| :-------------- | :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ChatGPT Web** | `src/providers/chatgpt/constants.ts` | `CONVERSATION_URL`, `SENTINEL_REQUIREMENTS_URL`, `WS_URL`, UI reasoning slider indices (`REASONING_EFFORT_MAP`), model list (`CHATGPT_WEB_MODELS`) |
| **Claude Web**  | `src/providers/claude/constants.ts`  | API routes (`ORGS_URL`, `API_BASE`), `USER_AGENT`, `SEC_CH_UA`, thinking effort mapping (`CLAUDE_REASONING_EFFORT_MAP`)                            |
| **Gemini Web**  | `src/providers/gemini/constants.ts`  | Frontend build ID (`DEFAULT_BL`), RPC endpoint (`STREAM_GENERATE_RPC`), payload slots (`PAYLOAD_SLOT_*`), model category slots                     |

When an upstream frontend update causes unexpected behavior:

1. Compare wire requests in your browser's DevTools Network tab with the corresponding `constants.ts` and `payload.ts`.
2. Check for updated build IDs (`gemini_bl`), new payload array slot indices, or renamed SSE event types.
3. Update the corresponding constants without needing to rewrite adapter logic.
