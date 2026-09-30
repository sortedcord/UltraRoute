# Gemini Web Integration — Repository Documentation

This directory documents two related but independently deployable projects maintained under `sortedcord`:

1. **[`gemini-web2api`](https://github.com/sortedcord/gemini-web2api)** — a Python HTTP bridge that translates OpenAI-compatible, OpenAI Responses, and Google Gemini-compatible requests into Gemini Web requests.
2. **[`AuthoCookie`](https://github.com/sortedcord/AuthoCookie)** — a Playwright sidecar that periodically visits Gemini Web using an existing authenticated cookie string and persists selected rotating authentication-cookie values.

AuthoCookie is optional. It is not an authentication provider, login bot, or dependency embedded in the API bridge; it can share a cookie directory with `gemini-web2api` so that the API service reads the latest cookie values when it handles requests.

## Contents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system overview, components, API surfaces, request lifecycle, configuration reference, deployment, security, limitations, and operational guidance for both repositories.
- [`docs/AUTHOCOOKIE.md`](docs/AUTHOCOOKIE.md): AuthoCookie-specific lifecycle, cookie transformation rules, Compose integration, and troubleshooting.

## Included source snapshots

- [`code/gemini-web2api/`](code/gemini-web2api/): selected Python implementation modules and example configuration, copied from the pinned `gemini-web2api` revision.
- [`code/AuthoCookie/`](code/AuthoCookie/): cookie keeper, merge utilities, package metadata, Dockerfile and Compose configuration, copied from the pinned AuthoCookie revision.

These are reference snapshots, not a runnable combined checkout. The full upstream repositories remain the source of truth; use the links below to inspect context, tests, licenses, and files not mirrored here. Keep the snapshot revision references synchronized when updating copied code.

The source snapshots are organized by upstream repository. Key bridge modules include [`server.py`](code/gemini-web2api/gemini_web2api/server.py), [`gemini.py`](code/gemini-web2api/gemini_web2api/gemini.py), [`conversation.py`](code/gemini-web2api/gemini_web2api/conversation.py), [`multimodal.py`](code/gemini-web2api/gemini_web2api/multimodal.py), and [`generated_image.py`](code/gemini-web2api/gemini_web2api/generated_image.py). AuthoCookie's core files are [`keeper.mjs`](code/AuthoCookie/keeper.mjs) and [`cookie-utils.mjs`](code/AuthoCookie/cookie-utils.mjs). See the architecture document's inventory for module roles. These files are copied as upstream source, not edited for this documentation set.

## Source snapshot and evidence

Documentation is based on the repositories' `main` branch snapshots inspected on 2026-09-30:

- `gemini-web2api`: [`b35758c`](https://github.com/sortedcord/gemini-web2api/tree/b35758c900e57df8f415be04cc5aaec49b80cf02)
- `AuthoCookie`: [`c298520`](https://github.com/sortedcord/AuthoCookie/tree/c2985204bdee8aed169b63305a6323030e6c3136)

Repository behavior, particularly Gemini's undocumented web protocol, can change independently of these snapshots. When repository code and this documentation differ, inspect the pinned source snapshot or current upstream source before operating the service.

## Important security note

An exported Gemini cookie is a bearer credential for an authenticated Google session. Protect it as a password/API key: use restrictive host permissions, do not commit or log it, do not publish browser debugging ports, and restrict network access to the API bridge. AuthoCookie only extends routine cookie rotation; it cannot re-authenticate a logged-out session or solve account challenges.
