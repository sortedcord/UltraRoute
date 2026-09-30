# UltraRoute — ChatGPT Web Context

This directory contains the architectural specification and implementation files for the ChatGPT Web provider (`chatgpt-web`) in OmniRoute.

## Directory Layout

- `docs/ARCHITECTURE.md`: Complete architecture documentation detailing the clean-room in-page browser bridge, storage state validation, model & reasoning selection, Sentinel & Proof-of-Work resolution, direct SSE & WebSocket handoff, and Delta V1 stream decoding.
- `code/open-sse/executors/chatgpt-web.ts`: `ChatGptWebExecutor` class extending `BaseExecutor`.
- `code/open-sse/utils/chatgptWebExecutorAdapter.ts`: Clean-room execution adapter, prompt preparation, reasoning effort mapping, and storage state normalization.
- `code/open-sse/utils/chatgptWebBrowserSession.ts`: Playwright session management, turn timeout runner, and direct conversation parser.
- `code/open-sse/utils/chatgptWebFirstParty.ts`: In-page reflection bridge for Sentinel requirements, Proof-of-Work, Turnstile tokens, and Azure blob attachment uploads.
- `code/open-sse/utils/chatgptWebTransport.ts`: WebSocket topic stream multiplexer and handoff bootstrap parser.
- `code/open-sse/utils/chatgptWebDeltaV1.ts`: Decoder for ChatGPT's internal `delta_encoding: "v1"` stream.
- `code/open-sse/config/providers/registry/chatgpt-web/index.ts`: Provider model catalog and thinking capabilities.
- `code/src/lib/providers/validation/chatgptWeb.ts`: Storage state and cookie credential validation.
