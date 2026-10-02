import type { Page, Response as BrowserResponse } from "playwright";
import type { ChatGptWebFirstPartyRequest } from "./firstParty.ts";
import { validateAttachments } from "../../shared/attachmentValidator.ts";
import { CHATGPT_WEB_CONSTANTS } from "./constants.ts";
import {
  installChatGptStreamCapture,
  resetChatGptStreamCapture,
  readChatGptStreamCapture,
} from "./streamCapture.ts";
import {
  ChallengeRequiredError,
  CredentialError,
  GenericUpstreamError,
  InvalidRequestError,
  ProviderTimeoutError,
  RateLimitError,
  UpstreamDriftError,
  WebProviderError,
} from "../../shared/errors.ts";

const CONTROL_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = CHATGPT_WEB_CONSTANTS.DEFAULT_TURN_TIMEOUT_MS;

/** Uses only visible native controls. Cancellation closes this page, never its context. */
export async function executeChatGptComposerTurn(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  options: { signal?: AbortSignal | null } = {},
): Promise<string> {
  const {
    promise: captured,
    resolve,
    reject,
  } = Promise.withResolvers<BrowserResponse>();
  let submitted = false;
  let settled = false;
  let stoppedError: ProviderTimeoutError | undefined;
  let closingPage: Promise<void> | undefined;
  const { promise: stopped, reject: rejectStopped } =
    Promise.withResolvers<never>();
  const ensureActive = () => {
    if (stoppedError) throw stoppedError;
  };
  const native = async <T>(action: () => Promise<T>): Promise<T> => {
    ensureActive();
    const result = await action();
    ensureActive();
    return result;
  };
  const stop = (message: string) => {
    if (stoppedError) return;
    stoppedError = new ProviderTimeoutError(message);
    settled = true;
    // Closing only the execution page cancels pending controls and its native
    // requests, including the page-local stream observer.
    closingPage = page.close({ runBeforeUnload: false }).catch(() => {});
    rejectStopped(stoppedError);
  };
  const onResponse = (response: BrowserResponse) => {
    if (!submitted || settled) return;
    const request = response.request();
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    const conversationPath = `/backend-api${CHATGPT_WEB_CONSTANTS.DIRECT_SSE_PATH}`;
    if (
      url.origin !== CHATGPT_WEB_CONSTANTS.BASE_URL ||
      request.method() !== "POST"
    )
      return;
    if (
      url.pathname !== conversationPath &&
      url.pathname !== `${conversationPath}/prepare`
    )
      return;
    const status = response.status();
    if (status === 401) {
      settled = true;
      reject(new CredentialError("ChatGPT browser session expired"));
    } else if (status === 403) {
      settled = true;
      reject(
        new ChallengeRequiredError(
          "ChatGPT requires security verification in the browser. Complete the normal page verification before retrying.",
        ),
      );
    } else if (status === 429) {
      settled = true;
      reject(new RateLimitError("ChatGPT browser quota or rate limit reached"));
    } else if (status < 200 || status >= 300) {
      settled = true;
      reject(
        new GenericUpstreamError("ChatGPT conversation request failed", status),
      );
    } else if (url.pathname === conversationPath) {
      settled = true;
      resolve(response);
    }
  };
  const onAbort = () => stop("ChatGPT browser turn cancelled");
  const timer = setTimeout(
    () => stop("ChatGPT browser conversation timed out"),
    TURN_TIMEOUT_MS,
  );
  // Either promise can reject while a native control is still pending.
  void captured.catch(() => {});
  void stopped.catch(() => {});
  page.on("response", onResponse);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let stage = "composer-ready";
  const operation = async () => {
    ensureActive();
    await native(() => page.bringToFront());
    await native(() => installChatGptStreamCapture(page));
    const composer = page.locator('[contenteditable="true"][role="textbox"]');
    await composer.waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS });
    const temporaryActive = page.getByRole("button", {
      name: "Turn off temporary chat",
      exact: true,
    });
    if (!(await temporaryActive.isVisible())) {
      const enable = page.getByRole("button", {
        name: "Turn on temporary chat",
        exact: true,
      });
      if (!(await enable.isVisible()))
        throw new UpstreamDriftError(
          "ChatGPT temporary-chat control is unavailable",
          { category: "composer-controls" },
        );
      await native(() => enable.click({ timeout: CONTROL_TIMEOUT_MS }));
      await temporaryActive.waitFor({
        state: "visible",
        timeout: CONTROL_TIMEOUT_MS,
      });
    }
    if (input.selection.kind === "picker") {
      const modelPicker = page.getByRole("button", {
        name: "Select ChatGPT model",
        exact: true,
      });
      await native(() =>
        modelPicker.waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS }),
      );
      if (!(await modelPicker.isVisible()))
        throw new InvalidRequestError(
          "The requested ChatGPT model is unavailable on this account",
        );
      stage = "model-menu";
      await native(() => modelPicker.click({ timeout: CONTROL_TIMEOUT_MS }));
      await native(() =>
        page
          .getByRole("menuitemradio", { includeHidden: true })
          .first()
          .waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS }),
      );
      const label = input.selection.modelLabel;
      const requestedModel = page
        .getByRole("menuitemradio", { includeHidden: true })
        .filter({
          hasText: new RegExp(
            `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s|\\(|Leaving\\b)`,
          ),
        });
      if (
        (await requestedModel.count()) !== 1 ||
        (await requestedModel.isDisabled())
      )
        throw new InvalidRequestError(
          "The requested ChatGPT model is unavailable on this account",
        );
      stage = "model-selection";
      if ((await requestedModel.getAttribute("aria-checked")) !== "true")
        await native(() =>
          requestedModel.click({ timeout: CONTROL_TIMEOUT_MS }),
        );
      const effort = input.selection.effortIndex;
      const modeItem = page.getByRole("menuitem", {
        name: "Select model",
        exact: true,
        includeHidden: true,
      });
      stage = "reasoning-menu";
      if (!(await modeItem.isVisible()))
        await native(() => modelPicker.click({ timeout: CONTROL_TIMEOUT_MS }));
      await modeItem.waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS });
      if ((await requestedModel.getAttribute("aria-checked")) !== "true")
        throw new InvalidRequestError(
          "The requested ChatGPT model could not be selected on this account",
        );
      const selectedMode = (await modeItem.innerText()).trim();
      const slider = page.getByRole("slider", { includeHidden: true });
      const observedEffort = /^Instant(?:$|\s)/.test(selectedMode)
        ? 0
        : /^Medium(?:$|\s)/.test(selectedMode)
          ? 1
          : /^High(?:$|\s)/.test(selectedMode)
            ? 2
            : null;
      if (effort === 4) {
        const pro = page.getByRole("menuitemradio", {
          name: "Pro",
          exact: true,
          includeHidden: true,
        });
        if (!(await pro.isVisible()) || (await pro.isDisabled()))
          throw new InvalidRequestError(
            "The requested ChatGPT Pro model is unavailable on this account",
          );
        if (selectedMode !== "Pro")
          await native(() => pro.click({ timeout: CONTROL_TIMEOUT_MS }));
        if ((await pro.getAttribute("aria-checked")) !== "true")
          throw new InvalidRequestError(
            "The requested ChatGPT Pro model could not be selected",
          );
      } else {
        const target =
          effort === 0
            ? 0
            : effort === 1 || effort === 2
              ? 1
              : effort === 3
                ? 2
                : -1;
        const max = Number(await slider.getAttribute("aria-valuemax"));
        const current = Number(await slider.getAttribute("aria-valuenow"));
        const instantAlreadySelected = effort === 0 && observedEffort === 0;
        if (
          target < 0 ||
          !Number.isInteger(max) ||
          max < 1 ||
          max > 2 ||
          !(await slider.isVisible()) ||
          (await slider.isDisabled())
        ) {
          if (!instantAlreadySelected)
            throw new InvalidRequestError(
              "The requested ChatGPT reasoning effort is unavailable on this account",
            );
        } else if (observedEffort !== target) {
          if (!Number.isInteger(current) || current < 0 || current > max)
            throw new InvalidRequestError(
              "ChatGPT reported an unsupported reasoning level",
            );
          await native(() => slider.focus({ timeout: CONTROL_TIMEOUT_MS }));
          for (let index = current; index < target; index++)
            await native(() =>
              slider.press("ArrowRight", { timeout: CONTROL_TIMEOUT_MS }),
            );
          for (let index = current; index > target; index--)
            await native(() =>
              slider.press("ArrowLeft", { timeout: CONTROL_TIMEOUT_MS }),
            );
        }
        if (!instantAlreadySelected) {
          const selectedValue = Number(
            await slider.getAttribute("aria-valuenow"),
          );
          const selectedLabel = (await modeItem.innerText()).trim();
          const expectedLabel =
            target === 0 ? "Instant" : target === 1 ? "Medium" : "High";
          if (
            selectedValue !== target ||
            !selectedLabel.startsWith(expectedLabel)
          )
            throw new InvalidRequestError(
              "The requested ChatGPT reasoning level could not be selected",
            );
        }
      }
      await native(() => page.keyboard.press("Escape"));
    } else {
      const instant = page.getByRole("button", {
        name: "Instant",
        exact: true,
      });
      const think = page.getByRole("button", { name: "Think", exact: true });
      const requested = input.selection.thinkEnabled ? think : instant;
      await native(() =>
        requested.waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS }),
      );
      if (!(await requested.isVisible()))
        throw new InvalidRequestError(
          "The requested ChatGPT free-account mode is unavailable",
        );
      await native(() => requested.click({ timeout: CONTROL_TIMEOUT_MS }));
    }
    if (input.attachments.length) {
      try {
        validateAttachments(
          input.attachments.map((attachment) => ({
            type: attachment.kind,
            mimeType: attachment.mimeType,
            data: attachment.data,
            dimensions:
              attachment.width && attachment.height
                ? { width: attachment.width, height: attachment.height }
                : undefined,
          })),
          { maxCount: 10, maxBytes: 50 * 1024 * 1024, allowRemoteUrls: false },
        );
        if (
          input.attachments.some(
            (attachment) =>
              attachment.size !== attachment.data.byteLength ||
              attachment.name !== attachment.name.split(/[\\/]/).pop() ||
              /[\u0000-\u001f\u007f]/.test(attachment.name),
          )
        )
          throw new Error("Invalid metadata");
      } catch {
        throw new InvalidRequestError("ChatGPT attachment metadata is invalid");
      }
      const fileInput = page.locator('input[type="file"]');
      if ((await fileInput.count()) !== 1)
        throw new UpstreamDriftError(
          "ChatGPT attachment input is unavailable",
          { category: "composer-controls" },
        );
      await native(() =>
        fileInput.setInputFiles(
          input.attachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            buffer: attachment.data,
          })),
          { timeout: CONTROL_TIMEOUT_MS },
        ),
      );
      for (const attachment of input.attachments)
        await page
          .getByText(attachment.name, { exact: true })
          .waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS });
      await page
        .getByRole("progressbar")
        .waitFor({ state: "hidden", timeout: CONTROL_TIMEOUT_MS });
    }
    await native(() =>
      composer.fill(input.prompt, { timeout: CONTROL_TIMEOUT_MS }),
    );
    stage = "send-ready";
    if (!(await temporaryActive.isVisible()))
      throw new UpstreamDriftError("ChatGPT temporary chat became inactive", {
        category: "composer-controls",
      });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await send.waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS });
    await page.waitForFunction(
      () => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Send"]',
        );
        return (
          !!button &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true"
        );
      },
      undefined,
      { timeout: CONTROL_TIMEOUT_MS },
    );
    ensureActive();
    await native(() => resetChatGptStreamCapture(page));
    submitted = true;
    await Promise.race([
      native(() => send.click({ timeout: CONTROL_TIMEOUT_MS })),
      captured.then(() => {}),
    ]);
    const response = await captured;
    const contentType = response.headers()["content-type"] ?? "";
    if (!/^(?:text\/event-stream|application\/json)(?:;|$)/i.test(contentType))
      throw new UpstreamDriftError(
        "ChatGPT conversation returned an unsupported response format",
        { category: "composer-response" },
      );
    ensureActive();
    return readChatGptStreamCapture(page, options.signal);
  };
  try {
    return await Promise.race([operation(), stopped]);
  } catch (error) {
    if (stoppedError) throw stoppedError;
    if (error instanceof WebProviderError) throw error;
    throw new UpstreamDriftError(
      "ChatGPT native composer controls or request changed",
      { category: "composer-controls", stage },
    );
  } finally {
    clearTimeout(timer);
    page.off("response", onResponse);
    options.signal?.removeEventListener("abort", onAbort);
    if (closingPage) {
      let cleanupTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closingPage,
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, CONTROL_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
  }
}
