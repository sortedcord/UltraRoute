---
title: "AuthoCookie Operations Reference"
lastUpdated: 2026-09-30
---

# AuthoCookie Operations Reference

## What it does

AuthoCookie is a small, standalone Node.js service using Playwright and Chromium. It periodically loads an operator-supplied Gemini session cookie into an isolated headless browser context, visits `https://gemini.google.com/app`, then persists changes for only this cookie family:

- `__Secure-1PSID`
- `__Secure-1PSIDTS`
- `__Secure-1PSIDCC`

It is a routine session-cookie rotation keeper. It does not log into Google, store a password, perform MFA, pass a CAPTCHA, solve account challenges, or publish an HTTP endpoint. A manually obtained authenticated cookie is a prerequisite.

## Runtime sequence

On startup, `keeper.mjs` launches one headless Chromium process and starts an immediate refresh. The worker reads `COOKIE_FILE`, validates that parsing includes `__Secure-1PSID`, adds parsed cookies to a `.google.com` secure cookie jar, creates a page and navigates to Gemini. It waits for `domcontentloaded` (up to 60 seconds), then waits the configured page settle interval. It compares current browser cookies with the initially loaded cookie string, replaces only nonempty values in the rotatable set, and atomically writes the merged string when changed. It repeats after the refresh interval. Browser/page errors are logged and the next scheduled cycle still runs. SIGTERM/SIGINT closes the context and browser.

When the cookie file changes on disk, the keeper detects the content mismatch on its next cycle, closes the old context, and creates a new one with the updated string. The refresh loop does not watch filesystem notifications; reload occurs on the periodic cycle (or after restart).

## Cookie merge semantics

`parseCookieString()` splits on semicolons, trims whitespace, uses the first `=` as the separator, and ignores empty/malformed pairs and cookie-attribute names (`domain`, `expires`, `httponly`, `max-age`, `path`, `samesite`, `secure`). `serializeCookies()` emits `name=value` pairs joined by `; `.

`mergeRotatedCookies(original, browserCookies)` preserves original order and unrelated values. For each original cookie, it substitutes a new value only when the browser has a nonempty value under one of the three allowlisted names. It appends an allowlisted cookie if it was absent in the original but exists in the browser jar. It does not add arbitrary browser cookies and does not remove original entries. A browser cookie with an empty value is ignored.

The atomic writer creates a temporary file in the destination directory, writes a newline-terminated trimmed value with mode `0600`, chmods it to `0600`, and renames it over the target. Keeping the temporary file in the same directory supports same-filesystem atomic rename.

## Install and run

Docker Compose is the supported quick path in the repository:

```bash
mkdir -p session
chmod 700 session
# Populate session/cookie.txt using a secure credential-handling process.
chmod 600 session/cookie.txt
docker compose up -d --build
docker compose logs -f authocookie
```

The project also publishes a prebuilt `linux/amd64` image at `ghcr.io/sortedcord/authocookie:latest`; the Compose service can refer to that image instead of `build: .`. The repository Compose configuration mounts the entire `./session` directory at `/session`; preserve this directory mount because replacing a single-file bind-mounted file can leave a consumer attached to an old inode.

Required runtime resources in the upstream README: Docker with Compose support, an existing authenticated cookie, and approximately 500 MB available for headless Chromium. The Compose file reserves 512 MB shared memory for Chromium stability.

## Environment

| Environment variable | Default | Description |
|---|---|---|
| `COOKIE_FILE` | `/session/cookie.txt` | Cookie string input and atomic output file. |
| `REFRESH_INTERVAL_MS` | `300000` | Delay between attempts (five minutes). Values are clamped to at least `60000` ms. |
| `PAGE_SETTLE_MS` | `5000` | Wait after Gemini navigation before reading the cookie jar; negative values clamp to zero. A configured `0` is treated as unset by the implementation and uses the 5000 ms default. |
| `BROWSER_USER_AGENT` | Chrome-like Linux user agent | Optional override for Chromium's user-agent. |

## Compose with gemini-web2api

A typical shared-directory arrangement gives the keeper write access and the API bridge read-only access:

```yaml
services:
  authocookie:
    build: ./AuthoCookie
    restart: unless-stopped
    init: true
    shm_size: "512mb"
    environment:
      COOKIE_FILE: /session/cookie.txt
      REFRESH_INTERVAL_MS: "300000"
      PAGE_SETTLE_MS: "5000"
    volumes:
      - ./session:/session

  gemini-web2api:
    # Image/build and network settings omitted.
    volumes:
      - ./session:/session:ro
      - ./config.json:/app/config.json:ro
```

In gemini-web2api configuration set:

```json
{
  "cookie_file": "/session/cookie.txt"
}
```

The bridge and keeper are not coupled by an RPC or health-check protocol. File sharing is their integration contract. Ensure the bridge reads the current file when making upstream requests; a process that loaded credentials only once must implement a safe reload/watch. The keeper only rotates its allowlisted cookie family; it does not refresh SAPISID, `SNlM0e`, or API keys.

## Credentials and security

- Treat `cookie.txt` as an account password or bearer token.
- Restrict the host `session/` directory to mode `0700` and cookie file to `0600`.
- Do not check cookie files into source control or include them in logs, shell history, Compose environment values, CI artifacts, or issue reports.
- Do not mount the session directory into untrusted containers. Give only the keeper write access; prefer a read-only API-service mount.
- Do not publish Chromium or remote-debugging ports. The keeper needs no inbound ports.
- Prefer a dedicated account and comply with account/website policies.
- Atomic replacement protects consumers from partial file writes, but it does not encrypt the file or protect it from a privileged host/container user.

## Updating or recovering a session

Routine rotation is automatic only while the loaded session remains accepted. If Google has logged out or revoked the session, requires a password/MFA/CAPTCHA, or raises a security challenge, manually obtain a fresh authenticated cookie export. Replace the file atomically with owner-only permissions. The worker reloads it on its next loop; restarting the container triggers immediate startup refresh.

## Logs and failure interpretation

Logs are prefixed `[cookie-keeper]` with ISO timestamps. Expected informational outcomes include browser start, credential context reload, no rotation observed, and rotation persisted. A successful refresh without a changed allowlisted cookie is not an error. An error repeating every interval suggests invalid/missing cookie, expired session, network/DNS/TLS failure, Chromium resource failure, inaccessible file/volume, or a Google challenge. The keeper catches an individual failure and continues its loop; investigate logs and session validity instead of assuming it will repair a logout.

## Development

The AuthoCookie README documents:

```bash
npm test
docker build -t authocookie .
```

Tests should use fabricated cookie values. Useful semantic coverage includes preserving unrelated cookie order/value, replacing each allowlisted value, adding newly observed allowlisted cookies only, ignoring empty values and cookie attributes, writing atomically with restrictive permissions, and recovering after a changed input file. Do not include real credentials in fixtures.

## Source snapshot

This reference documents [`sortedcord/AuthoCookie` revision `c2985204bdee8aed169b63305a6323030e6c3136`](https://github.com/sortedcord/AuthoCookie/tree/c2985204bdee8aed169b63305a6323030e6c3136). See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the bridge architecture and source links.
