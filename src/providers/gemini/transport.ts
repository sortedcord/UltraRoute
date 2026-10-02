import { request } from "node:https";
import type { IGeminiWebTransport } from "./adapter.ts";
import { discoverGeminiModels } from "./models.ts";
import { GEMINI_WEB_CONSTANTS } from "./constants.ts";
import { classifyHttpError, UpstreamDriftError } from "../../shared/errors.ts";

export function parseGeminiBootstrap(html: string) {
  const field = (name: string): string | undefined => {
    const encoded = html.match(new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`))?.[1];
    if (!encoded) return undefined;
    const value: unknown = JSON.parse(encoded);
    return typeof value === "string" && value ? value : undefined;
  };
  const at = field("SNlM0e") ?? field("thykhd");
  const build = field("cfb2h");
  const sessionId = field("FdrFJe");
  if (!at || !build) throw new UpstreamDriftError("Gemini bootstrap token or build ID missing");
  return { at, build, sessionId };
}

export class LiveGeminiWebTransport implements IGeminiWebTransport {
  discoverModels = discoverGeminiModels;

  async postStreamGenerate(payload: unknown, cookieHeader: string, sapisidHash: string | undefined, modelId: string, signal?: AbortSignal): Promise<string> {
    const html = await new Promise<string>((resolve, reject) => {
      const req = request(`${GEMINI_WEB_CONSTANTS.BASE_URL}/app`, {
        maxHeaderSize: 64 * 1024, signal,
        headers: { Cookie: cookieHeader, ...(sapisidHash ? { Authorization: sapisidHash } : {}) },
      }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) reject(classifyHttpError(res.statusCode ?? 502, body, "Gemini Web"));
          else resolve(body);
        });
      });
      req.on("error", reject);
      req.end();
    });
    const { at, build, sessionId } = parseGeminiBootstrap(html);
    const params = new URLSearchParams({ "f.req": JSON.stringify([null, JSON.stringify(payload)]), at });
    const url = new URL(GEMINI_WEB_CONSTANTS.STREAM_GENERATE_RPC, GEMINI_WEB_CONSTANTS.BASE_URL);
    url.search = new URLSearchParams({ bl: build, ...(sessionId ? { "f.sid": sessionId } : {}), _reqid: "12345", rt: "c" }).toString();
    // The upstream picker sends the opaque model ID in this protobuf JSON header.
    const modelHeader = [1, null, null, null, modelId];
    const res = await fetch(url, {
      method: "POST", headers: {
        Cookie: cookieHeader, ...(sapisidHash ? { Authorization: sapisidHash } : {}),
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        Origin: GEMINI_WEB_CONSTANTS.BASE_URL, Referer: `${GEMINI_WEB_CONSTANTS.BASE_URL}/app`,
        "x-goog-ext-525001261-jspb": JSON.stringify(modelHeader),
      }, body: params.toString(), signal,
    });
    if (!res.ok) throw classifyHttpError(res.status, await res.text(), "Gemini Web");
    return res.text();
  }
}
