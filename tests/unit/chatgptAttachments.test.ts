import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import type { AttachmentSource } from "../../src/shared/types.ts";
import {
  resolveChatGptWebAttachments,
  isPublicAttachmentAddress,
  ChatGptWebAttachmentError,
  MAX_CHATGPT_WEB_IMAGE_BYTES,
  MAX_CHATGPT_WEB_FILE_BYTES,
} from "../../src/providers/chatgpt/attachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
const file = (url: string): AttachmentSource => ({
  type: "file",
  mimeType: "text/plain",
  url,
});

describe("ChatGPT shared attachment resolution", () => {
  test("resolves current shared byte/data URL inputs and sanitized names with detected dimensions", async () => {
    const resolved = await resolveChatGptWebAttachments([
      {
        type: "image",
        mimeType: "image/png",
        data: png,
        fileName: "../folder/\u0000picture.png",
        dimensions: { width: 5, height: 5 },
      },
      {
        type: "file",
        mimeType: "text/plain",
        url: "data:text/plain;base64,aGVsbG8=",
        fileName: "C:\\folder\\notes.txt",
      },
    ]);
    assert.equal(resolved[0].kind, "image");
    assert.equal(resolved[0].name, "picture.png");
    assert.equal(resolved[0].mimeType, "image/png");
    assert.equal(resolved[0].width, 1);
    assert.equal(resolved[0].height, 1);
    assert.deepEqual(resolved[0].data, png);
    assert.equal(resolved[1].name, "notes.txt");
    assert.equal(resolved[1].data.toString(), "hello");
    assert.equal(resolved[1].size, 5);
  });
  test("rejects MIME mismatches, undecodable images, decode bombs and invalid base64", async () => {
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(8193, 16);
    const tooManyPixels = Buffer.from(png);
    tooManyPixels.writeUInt32BE(6000, 16);
    tooManyPixels.writeUInt32BE(6000, 20);
    for (const source of [
      { type: "image" as const, mimeType: "image/jpeg", data: png },
      {
        type: "image" as const,
        mimeType: "image/png",
        data: Buffer.from("not an image"),
      },
      { type: "image" as const, mimeType: "image/png", data: bomb },
      { type: "image" as const, mimeType: "image/png", data: tooManyPixels },
      file("data:text/plain;base64,a===FAKE_SECRET"),
      file("data:text/plain,hello"),
      { type: "file" as const, mimeType: "text/plain" },
    ])
      await assert.rejects(
        resolveChatGptWebAttachments([source]),
        (error: unknown) =>
          error instanceof ChatGptWebAttachmentError &&
          !error.message.includes("FAKE_SECRET"),
      );
  });
  test("enforces attachment count, per-kind byte caps and combined byte cap", async () => {
    await assert.rejects(
      resolveChatGptWebAttachments(
        Array.from({ length: 11 }, () => ({
          type: "file",
          mimeType: "text/plain",
          data: Buffer.from("x"),
        })),
      ),
      /validation failed/,
    );
    await assert.rejects(
      resolveChatGptWebAttachments([
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.alloc(MAX_CHATGPT_WEB_IMAGE_BYTES + 1),
        },
      ]),
      /too large/,
    );
    await assert.rejects(
      resolveChatGptWebAttachments([
        {
          type: "file",
          mimeType: "text/plain",
          data: Buffer.alloc(MAX_CHATGPT_WEB_FILE_BYTES + 1),
        },
      ]),
      /validation failed/,
    );
    const chunk = Buffer.alloc(26 * 1024 * 1024);
    await assert.rejects(
      resolveChatGptWebAttachments([
        { type: "file", mimeType: "text/plain", data: chunk },
        { type: "file", mimeType: "text/plain", data: chunk },
      ]),
      /Combined/,
    );
  });
});

describe("ChatGPT public-only pinned attachment fetch", () => {
  test("rejects private, special-use and IPv4-mapped IPv6 hosts before network", async () => {
    const privateAddresses = [
      "127.0.0.2",
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "192.0.2.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
    ];
    for (const address of privateAddresses)
      assert.equal(isPublicAttachmentAddress(address), false, address);
    assert.equal(isPublicAttachmentAddress("8.8.8.8"), true);
    assert.equal(isPublicAttachmentAddress("2606:4700:4700::1111"), true);
    let fetched = false;
    for (const url of [
      "http://127.0.0.2/secret",
      "http://[::ffff:127.0.0.1]/secret",
      "ftp://public.test/secret",
      "https://FAKE_SECRET@public.test/secret",
    ]) {
      await assert.rejects(
        resolveChatGptWebAttachments([file(url)], {
          lookup: async () => [{ address: "127.0.0.1", family: 4 }],
          fetchRemoteMedia: async () => {
            fetched = true;
            return { bytes: Buffer.from("bad"), mimeType: "text/plain" };
          },
        }),
        ChatGptWebAttachmentError,
      );
    }
    await assert.rejects(
      resolveChatGptWebAttachments([file("https://mixed.test/secret")], {
        lookup: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
        fetchRemoteMedia: async () => {
          fetched = true;
          return { bytes: Buffer.from("bad"), mimeType: "text/plain" };
        },
      }),
      /blocked/,
    );
    assert.equal(fetched, false);
  });
  test("does not leak resolver/network errors or fetch after cancellation", async () => {
    await assert.rejects(
      resolveChatGptWebAttachments([file("https://public.test/x")], {
        lookup: async () => {
          throw new Error("FAKE_SECRET internal-id=x");
        },
      }),
      (error: unknown) =>
        error instanceof ChatGptWebAttachmentError &&
        error.cause === undefined &&
        !error.message.includes("FAKE_SECRET"),
    );
    const controller = new AbortController();
    controller.abort();
    let fetched = false;
    await assert.rejects(
      resolveChatGptWebAttachments([file("https://public.test/x")], {
        signal: controller.signal,
        fetchRemoteMedia: async () => {
          fetched = true;
          return { bytes: Buffer.from("bad"), mimeType: "text/plain" };
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(fetched, false);
  });
  test("pinned HTTP transport rejects redirects without fetching their target, bounds bodies and sends no credentials", async () => {
    let redirected = false;
    const server = createServer((req, res) => {
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers.authorization, undefined);
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/private" });
        res.end();
      } else if (req.url === "/private") {
        redirected = true;
        res.end("secret");
      } else if (req.url === "/oversized") {
        res.writeHead(200, {
          "content-length": String(MAX_CHATGPT_WEB_FILE_BYTES + 1),
        });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("public file");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const port = address.port;
    // Inject only the connection endpoint: production URL/DNS/pinning policy still runs.
    const localRequest = ((
      url: URL,
      options: Record<string, unknown>,
      callback: Parameters<typeof request>[2],
    ) => {
      return request(
        new URL(`http://127.0.0.1:${port}${url.pathname}`),
        { ...options, lookup: undefined },
        callback,
      );
    }) as typeof request;
    const deps = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      request: localRequest,
    };
    try {
      const resolved = await resolveChatGptWebAttachments(
        [file("http://public.test/success")],
        deps,
      );
      assert.equal(resolved[0].data.toString(), "public file");
      await assert.rejects(
        resolveChatGptWebAttachments(
          [file("http://public.test/redirect")],
          deps,
        ),
        /redirects are blocked/,
      );
      assert.equal(redirected, false);
      await assert.rejects(
        resolveChatGptWebAttachments(
          [file("http://public.test/oversized")],
          deps,
        ),
        /too large/,
      );
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
});
