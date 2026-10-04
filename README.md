# UltraRoute

UltraRoute connects a chat interface to ChatGPT, Claude, and Gemini Web through their signed-in web sessions. The server translates chat requests and provider responses while keeping credentials on the server.

## Chat workspace

The workspace uses the Prismfield design system: a quiet white canvas, a colorful frame, geometric headings, and lime actions. It includes a model picker with provider tabs, a per model reasoning control, inline Gemini source citations, and a responsive chat transcript.

The composer **+** menu keeps “More uploads” and “More tools” in the main list. Their expanded options remain side flyouts on desktop and expand inline inside the mobile drawer.

On screens narrower than 860px, the model picker and **+** menu slide in from below the viewport without focus-induced jumps. Pull the handle down to dismiss; a short pull snaps back. Tap the handle or the dimmed area, or press Escape, to close. Drawer content scrolls independently, and keyboard focus stays inside the open drawer.

The mobile header shows only the sidebar button. Navigation fills the screen: open it with the button or swipe right from the left edge, then close with the collapse button or Escape. Desktop navigation and anchored menus are unchanged. Drawer and navigation transitions respect reduced-motion preferences.

<!-- README_SCREENSHOT_START -->

![UltraRoute chat workspace](docs/images/chat-workspace.png)
<!-- README_SCREENSHOT_END -->

To regenerate the image locally, start the server, then run `npm run screenshot:readme`. The `Update README screenshot` GitHub Actions workflow does the same on each push to `master` and commits changes to the image and README.

## Run locally

Requirements: Node.js 22 or newer and npm.

```bash
npm run build:client
npm run server
```

`build:client` writes the generated browser bundle to `dist/bundle.js`. The bundle is gitignored; rebuild it after changing client code before running the server. `public/index.html` loads `/dist/bundle.js`.

Open [http://localhost:3000](http://localhost:3000).

The server loads `.env.local` and `.env` when present. Keep both files private. Set `GEMINI_COOKIE_FILE` to the file AuthoCookie updates. The server reads it for model discovery and chat, then uses the refreshed cookie values. If it is unset, UltraRoute reads Gemini cookies from the local Chromium profile. Set `GEMINI_CHROMIUM_PATH` if Chromium is installed elsewhere.

The server saves each account's ChatGPT, Claude, and Gemini model lists. It loads saved lists at startup and refreshes them every six hours. Set `MODEL_CATALOG_CACHE_FILE` to change the file location or `MODEL_CATALOG_REFRESH_INTERVAL_MS` to change the interval. Snapshot files are private and do not contain credentials. If an update fails, the server keeps the last successful list. Initial discovery failures are shown in the provider's model-picker tab; there is no static fallback catalog.

The workspace rereads cached catalogs when focused or returned to a visible tab, and every five minutes while visible. This does not force an upstream refresh. Existing rows remain available while loading or after a discovery error; updated catalogs repair unavailable model/preset selections instead of sending obsolete choices.

For ChatGPT, prefer `CHATGPT_BROWSER_PROFILE` with an absolute dedicated Chromium profile directory. Prepare it with `CHATGPT_BROWSER_PROFILE=/absolute/dedicated/path npm run chatgpt:session`, sign in normally, then close that preparation window before starting the server. The session command reads the process environment directly, not `.env.local`. `CHATGPT_STORAGE_STATE_FILE` and `CHATGPT_COOKIE_HEADER` are also supported; explicit ChatGPT credentials avoid local Chromium cookie extraction on each chat request. For Claude, use an existing local Chromium session.

The following commands check the client, types, and unit tests:

```bash
npm run build:client
npm run typecheck
npm test
```

The unit tests use local fixtures. They do not need provider credentials or make live requests.

## Providers

### ChatGPT Web

ChatGPT uses a warm in-page co-processor: one authenticated Chromium page per configured profile or session identity. Successful turns reuse that page without navigation, composer clicks, or file-input automation. UltraRoute discovers the active frontend's cached request client and invokes its native request/integrity functions inside the browser; credentials and verification artifacts remain browser-local. This is browser-backed execution, not a browserless HTTP client or a CAPTCHA solver.

Turns for the same session are serialized; different sessions do not share contexts. A lease is released after the complete response, not by closing Chromium. Idle browsers close after five minutes; set `CHATGPT_BROWSER_IDLE_TIMEOUT_MS` to a nonnegative millisecond value (`0` closes immediately after release). Cancellation interrupts the execution page and replaces it while retaining its browser context. Server shutdown aborts active turns and closes owned browsers. `CHATGPT_CHROMIUM_PATH` overrides Chromium's executable; `CHATGPT_WEB_HEADLESS=1` requests headless mode. Interactive login, MFA, or security verification must be completed normally in the dedicated profile. Protect profiles like passwords and do not share them between accounts.

Each request starts an independent temporary upstream chat and replays the supplied transcript as role-prefixed user text; warming the page does not provide native conversation continuation or native system-message semantics. Model families, display names, availability, and reasoning presets come from the signed-in account's native model catalog. The picker shows only available presets: Instant sends `none` without a thinking effort, Medium sends `medium` using native `standard` thinking, and High sends `high` using native `extended` thinking. Unsupported efforts are rejected rather than mapped to other presets; locked families remain visible but cannot be selected. Catalog IDs use the `chatgpt-web:` prefix followed by the encoded upstream version ID, not native model slugs. Native frontend changes can produce `UPSTREAM_DRIFT`.

File/photo attachments are supported through the workspace and `/api/chat` for ChatGPT only. AI SDK file parts use `{type:"file", url:"data:<mime>;base64,...", mediaType:"<mime>", filename:"name"}`; remote HTTP(S) URLs require explicit media type and are checked by the server resolver. Limits are 10 attachments, 20 MiB per image, 50 MiB per file, and 50 MiB combined. Blob uploads receive no ChatGPT cookies or bearer headers. The workspace shows attached filenames and allows removal before sending.

A ChatGPT turn is buffered before UltraRoute returns it, so tokens do not stream incrementally. The decoder requires a successfully finished assistant response; `[DONE]` alone does not establish completion. `CHATGPT_WEB_EXECUTION=module` is no longer needed: native in-page execution is the only transport.

### Claude Web

Claude model discovery uses the signed in account's catalog. Locked models remain visible but cannot be selected. Reasoning levels come from the model catalog. Claude conversations keep continuation state scoped to the account, organization, model, and transcript.

### Gemini Web

Gemini model discovery uses the signed in account's model picker. It keeps Google's model IDs. The reasoning slider maps Low and High to normal and extended thinking. Grounded answers keep their source links and citation ranges. Hover a citation to highlight the text it supports.

Gemini Web returns completed answers through the StreamGenerate protocol. Continued chats are buffered before UltraRoute returns them. Gemini's bootstrap can provide either `SNlM0e` or `thykhd`; UltraRoute also sends `FdrFJe` when present.

## Security and limitations

- Keep cookies, session keys, API keys, browser state files, and browser profiles private. Never commit real credentials.
- Attachments are checked for count, size, media type, and image dimensions. Remote downloads reject private and local network addresses and redirects.
- UltraRoute does not solve CAPTCHA, Cloudflare Turnstile, or login challenges. Resolve them in the signed in provider session.
- Provider web interfaces can change without notice. If a request reports `UPSTREAM_DRIFT`, inspect the relevant provider decoder and current response format.

## Integration tests

The local Chromium tests use fabricated protocol data and block external requests. Install Playwright Chromium if it is not already available, then run:

```bash
RUN_BROWSER_TESTS=1 npm run test:integration
```

Tests using actual provider sessions are opt in. The normal integration command does not enable them. Live tests require `RUN_LIVE_TESTS=1`; tests that use a ChatGPT browser profile also require `RUN_PROFILE_TESTS=1`.

The ChatGPT browser fixture suite is `tests/integration/chatgptInPage.test.ts`. It routes fabricated native-runtime modules and responses locally, covering repeated turns, cancellation, UTF-8/size bounds, typed errors, and upload privacy. It does not certify current upstream behavior. Live profile tests use the warm manager and close it explicitly after execution.

`tests/integration/mobileWorkspace.test.ts` exercises the built workspace against local catalog fixtures, including discovered ChatGPT family/preset choices, per-model reasoning memory, and loading/error states without fallback models, alongside mobile and desktop navigation.

## Project layout

- `src/client/` contains the React workspace, model picker, styles, and citation rendering.
- `src/providers/` contains provider discovery, request handling, and response decoders.
- `src/shared/` contains shared request types, validation, errors, and continuation state.

The model cache is scoped by a SHA-256 hash of provider account material; ChatGPT discovery obtains the authenticated account identity from its warm browser page rather than using the profile path as the account. Snapshot files have owner-only permissions and are replaced atomically. Model status responses from `GET /api/providers/chatgpt-web/models` (and the corresponding Claude/Gemini routes) include `catalogStatus` with a fetch time, stale flag, and optional safe refresh error. There is no force-refresh endpoint. The server currently listens on all interfaces without administrator authentication, so adding an unauthenticated refresh route would expose upstream credentials.
