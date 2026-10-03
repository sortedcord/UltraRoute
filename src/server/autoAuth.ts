import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import type { ChatGptStorageState } from "../providers/chatgpt/storageState.ts";
import { validateAndNormalizeStorageState } from "../providers/chatgpt/storageState.ts";

export interface ExtractedCredentials {
  claude?: {
    cookieHeader: string;
    sessionKey: string;
    lastActiveOrg?: string;
  };
  gemini?: {
    cookieHeader: string;
    secure1PSID?: string;
    secure1PSIDTS?: string;
    sapisid?: string;
  };
  chatgpt?: {
    cookieHeader: string;
    storageState?: ChatGptStorageState;
    browserProfile?: string;
  };
}

export type ChromiumCredentialProvider =
  "chatgpt-web" | "claude-web" | "gemini-web";

function configuredChatGptCredentials(): ExtractedCredentials["chatgpt"] {
  if (process.env.CHATGPT_BROWSER_PROFILE) {
    return {
      cookieHeader: "",
      browserProfile: process.env.CHATGPT_BROWSER_PROFILE,
    };
  }
  const configuredState = process.env.CHATGPT_STORAGE_STATE_FILE;
  const configuredCookie = process.env.CHATGPT_COOKIE_HEADER;
  if (!configuredState && !configuredCookie) return undefined;
  return {
    cookieHeader: "",
    storageState: validateAndNormalizeStorageState(
      configuredState
        ? readFileSync(configuredState, "utf8")
        : configuredCookie,
    ),
  };
}

export function extractChromiumCredentials(
  provider?: ChromiumCredentialProvider,
): ExtractedCredentials | null {
  // Explicit ChatGPT profiles/state need no DBus or unrelated browser-cookie reads.
  const configuredChatGpt =
    !provider || provider === "chatgpt-web"
      ? configuredChatGptCredentials()
      : undefined;
  if (provider === "chatgpt-web" && configuredChatGpt)
    return { chatgpt: configuredChatGpt };
  const pythonScript = `
import dbus, os, sqlite3, json, sys
target = sys.argv[1]
from hashlib import pbkdf2_hmac
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding

try:
    bus = dbus.SessionBus()
    service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    sec_svc = dbus.Interface(service, 'org.freedesktop.Secret.Service')
    output, session_path = sec_svc.OpenSession('plain', dbus.String('', variant_level=1))

    unlocked, locked = sec_svc.SearchItems({'application': 'chromium'})
    sec_item = dbus.Interface(bus.get_object('org.freedesktop.secrets', unlocked[0]), 'org.freedesktop.Secret.Item')
    secret = sec_item.GetSecret(session_path)
    raw_pw = bytes(secret[2])

    key = pbkdf2_hmac('sha1', raw_pw, b'saltysalt', 1, 16)
    iv = b' ' * 16

    def decrypt(enc, offset=32):
        if not enc:
            return ''
        if enc[:3] == b'v11':
            ciphertext = enc[3:]
            cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
            decryptor = cipher.decryptor()
            padded = decryptor.update(ciphertext) + decryptor.finalize()
            unpadder = padding.PKCS7(128).unpadder()
            pt = unpadder.update(padded) + unpadder.finalize()
            if offset:
                pt = pt[offset:]
            return pt.decode('utf-8', errors='ignore')
        return ''

    conn = sqlite3.connect(os.path.expanduser('~/.config/chromium/Default/Cookies'))
    cur = conn.cursor()

    # Claude
    cur.execute("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%' AND name IN ('sessionKey', 'lastActiveOrg') AND ? IN ('all', 'claude-web');", (target,))
    claude_dict = {name: decrypt(enc) for name, enc in cur.fetchall()}

    # Gemini bootstrap needs the complete Google auth session, not just PSID/SAPISID.
    # Only cookies applicable to https://gemini.google.com/app are sent.
    cur.execute("SELECT name, encrypted_value, value, expires_utc, host_key FROM cookies WHERE host_key IN ('.google.com', 'google.com', 'gemini.google.com', '.gemini.google.com') AND path = '/' AND name IN ('SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'SIDCC', '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-1PSIDCC', '__Secure-3PSIDCC', '__Secure-1PAPISID', '__Secure-3PAPISID') AND ? IN ('all', 'gemini-web') ORDER BY LENGTH(host_key);", (target,))
    gemini_dict = {}
    for name, enc, plain, expires, host in cur.fetchall():
        val = decrypt(enc) if enc else plain
        unix_expires = expires / 1000000 - 11644473600 if expires else -1
        if val and (unix_expires == -1 or unix_expires > __import__('time').time()):
            gemini_dict[name] = val

    # Preserve browser domain/path attributes; never flatten OpenAI-host cookies onto ChatGPT.
    cur.execute("SELECT name, encrypted_value, value, host_key, path, expires_utc, is_httponly, is_secure, samesite FROM cookies WHERE host_key IN ('chatgpt.com', '.chatgpt.com', 'openai.com', '.openai.com', 'auth.openai.com', '.auth.openai.com') AND ? IN ('all', 'chatgpt-web');", (target,))
    cgpt_cookies = []
    for name, enc, plain, host, path, expires, httponly, secure, same in cur.fetchall():
        val = decrypt(enc) if enc else plain
        unix_expires = expires / 1000000 - 11644473600 if expires else -1
        if val and (unix_expires == -1 or unix_expires > __import__('time').time()):
            cgpt_cookies.append({'name': name, 'value': val, 'domain': host, 'path': path, 'expires': unix_expires, 'httpOnly': bool(httponly), 'secure': bool(secure), 'sameSite': {0: 'None', 1: 'Lax', 2: 'Strict'}.get(same, 'Lax')})

    result = {}
    if claude_dict.get('sessionKey'):
        result['claude'] = {
            'cookieHeader': '; '.join(f'{k}={v}' for k, v in claude_dict.items()),
            'sessionKey': claude_dict['sessionKey'],
            'lastActiveOrg': claude_dict.get('lastActiveOrg')
        }
    if gemini_dict.get('__Secure-1PSID'):
        result['gemini'] = {
            'cookieHeader': '; '.join(f'{k}={v}' for k, v in gemini_dict.items()),
            'secure1PSID': gemini_dict.get('__Secure-1PSID'),
            'secure1PSIDTS': gemini_dict.get('__Secure-1PSIDTS'),
            'sapisid': gemini_dict.get('SAPISID')
        }
    if cgpt_cookies:
        result['chatgpt'] = {
            'cookieHeader': '; '.join(f"{c['name']}={c['value']}" for c in cgpt_cookies if c['domain'] in ('chatgpt.com', '.chatgpt.com') and c['path'] == '/'),
            'storageState': {'cookies': cgpt_cookies, 'origins': []}
        }
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({}))
`;

  let credentials: ExtractedCredentials = {};
  try {
    const stdout = execFileSync(
      "python3",
      ["-c", pythonScript, provider ?? "all"],
      {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    credentials = JSON.parse(stdout) as ExtractedCredentials;
  } catch {
    // Chromium profile is optional when the operator configures a cookie or state file.
  }
  // Check for operator-configured Gemini cookie file or header (AuthoCookie sidecar pattern)
  const geminiCookieFile = process.env.GEMINI_COOKIE_FILE;
  const geminiCookieHeader = process.env.GEMINI_COOKIE;
  if (
    (!provider || provider === "gemini-web") &&
    (geminiCookieFile || geminiCookieHeader)
  ) {
    let rawCookie = "";
    if (geminiCookieFile && existsSync(geminiCookieFile)) {
      const content = readFileSync(geminiCookieFile, "utf-8").trim();
      if (content.startsWith("{")) {
        try {
          const json = JSON.parse(content) as Record<string, unknown>;
          rawCookie = (json.cookie as string) || "";
        } catch {
          rawCookie = content;
        }
      } else {
        rawCookie = content;
      }
    } else if (geminiCookieHeader) {
      rawCookie = geminiCookieHeader.trim();
    }
    if (rawCookie) {
      credentials.gemini = {
        cookieHeader: rawCookie,
      };
    }
  }
  if (configuredChatGpt) credentials.chatgpt = configuredChatGpt;
  return credentials;
}
