import type { ModelRegistry } from "../registry/models.ts";
import type { ExtractedCredentials } from "./autoAuth.ts";
import { InvalidRequestError } from "../shared/errors.ts";

export interface ChatRoute {
  providerId: string;
  model: string;
}

const GOOGLE_SDK_MODEL = "gemini-3.5-flash-lite";

/** Explicit SDK selection is independent of the web model registry. */
export function resolveChatRoute(
  registry: ModelRegistry,
  model: string = GOOGLE_SDK_MODEL,
  provider?: string,
): ChatRoute {
  if (provider === "claude-web" && model.startsWith("claude-")) {
    // Claude validates the exact ID and account access against its upstream catalog.
    return { providerId: "claude-web", model };
  }
  if (provider === "gemini-web" && model.startsWith("gemini-web:")) {
    return { providerId: "gemini-web", model };
  }
  const descriptor = registry.resolve(model);
  if (provider === "google") {
    if (
      !(descriptor?.id ?? model).startsWith("gemini-") || model.startsWith("gemini-web:") ||
      (descriptor && descriptor.providerId !== "gemini-web")
    ) {
      throw new InvalidRequestError(
        "The selected model does not belong to Google.",
      );
    }
    return { providerId: "google", model: descriptor?.id ?? model };
  }
  if (descriptor) {
    if (provider !== undefined && provider !== descriptor.providerId) {
      throw new InvalidRequestError(
        "The selected provider does not match the model.",
      );
    }
    return { providerId: descriptor.providerId, model: descriptor.id };
  }
  if (provider === undefined && model === GOOGLE_SDK_MODEL) {
    return { providerId: "google", model };
  }
  throw new InvalidRequestError(
    "Unknown model or incompatible provider selection.",
  );
}

/** Pass each adapter its native credential shape, not another provider's cookie. */
export function getCredentialsForProvider(
  providerId: string,
  credentials: ExtractedCredentials | null,
): unknown {
  switch (providerId) {
    case "chatgpt-web":
      if (credentials?.chatgpt?.browserProfile)
        return { browserProfile: credentials.chatgpt.browserProfile };
      return (
        credentials?.chatgpt?.storageState ?? credentials?.chatgpt?.cookieHeader
      );
    case "claude-web":
      return credentials?.claude?.sessionKey
        ? {
            sessionKey: credentials.claude.sessionKey,
            organizationId: credentials.claude.lastActiveOrg,
          }
        : credentials?.claude?.cookieHeader;
    case "gemini-web":
      return credentials?.gemini?.cookieHeader;
    default:
      return undefined;
  }
}
