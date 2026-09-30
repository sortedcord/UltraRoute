# UltraRoute — Claude Web Context

This directory stores the architectural analysis and key implementation files for the Claude Web provider in OmniRoute for reference and context.

## Contents

- `docs/ARCHITECTURE.md`: Complete architectural documentation covering authentication, session state caching, payload & reasoning transformation, dual-transport engine (direct TLS vs. browser context), SSE parsing, and tool idle finish synthesis.
- `code/open-sse/executors/claude-web.ts`: Main host orchestrator class `ClaudeWebExecutor`.
- `code/open-sse/executors/claude-web/session.ts`: Multi-turn session manager, SHA-256 account-scoped cache, and recovery prompt builder.
- `code/open-sse/executors/claude-web/payload.ts`: OpenAI to Claude Web request/tool transformation and reasoning effort mapping.
- `code/open-sse/executors/claude-web/transport.ts`: Direct TLS transport via `tlsFetchClaude()`.
- `code/open-sse/executors/claude-web/browserTransport.ts`: Browser context fallback via Playwright.
- `code/open-sse/executors/claude-web/stream.ts`: SSE event decoder, content & thinking delta mapping, and tool idle timeout logic.
- `code/open-sse/services/claudeTlsClient.ts`: Chrome 146 TLS profile client wrapper (`wreq-js`).
- `code/open-sse/services/claudeTurnstileSolver.ts`: Cloudflare Turnstile headless challenge solver.
- `code/open-sse/config/claudeWebFingerprint.ts`: Unified browser fingerprint definition.
- `code/src/lib/providers/validation/webProvidersB.ts`: `validateClaudeWebProvider` credential verification handler.
