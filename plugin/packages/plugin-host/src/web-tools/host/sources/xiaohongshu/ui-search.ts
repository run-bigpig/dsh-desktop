import type { CdpPageLease } from "../../browser/types.ts";
import {
  detectXhsPageState,
  waitForStableXhsPageState,
  type XhsPageState,
} from "../../browser/xiaohongshu-page-state.ts";
import {
  extractXhsSearchState,
} from "../browser-scripts/xiaohongshu.ts";

export type XhsSearchNavigationState = XhsPageState | "navigation-failed";

export interface XhsSearchNavigationOutcome {
  state: XhsSearchNavigationState;
  stage: "explore" | "after-submit";
  url: string;
}

interface XhsSearchNavigationOptions {
  searchControlTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Browser-executed helper. Keep self-contained because CdpPage.call serializes it. */
export function focusVisibleXhsSearchInput(): boolean {
  const selectors = [
    "textarea#search-input-in-feeds",
    "#search-input",
    "input.search-input",
    ".search-input input",
    "input[type='search']",
    "input[placeholder*='搜索']",
    "textarea[placeholder*='搜索']",
  ];
  const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  for (const element of candidates) {
    if (
      !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) ||
      element.disabled ||
      element.readOnly ||
      element.getAttribute("aria-hidden") === "true" ||
      element.tabIndex < 0
    ) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const opacity = Number.parseFloat(style.opacity || "1");
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.pointerEvents === "none" ||
      opacity <= 0.01 ||
      rect.width <= 0 ||
      rect.height <= 0
    ) continue;
    element.focus();
    if (document.activeElement === element) return true;
  }
  return false;
}

/** Enter XHS search through the visible home-page controls, never a direct search URL. */
export async function navigateXhsSearchViaUi(
  page: CdpPageLease,
  query: string,
  signal?: AbortSignal,
  options: XhsSearchNavigationOptions = {},
): Promise<XhsSearchNavigationOutcome> {
  await page.navigate("https://www.xiaohongshu.com/explore", signal);
  await page.waitForLoad(signal);

  const initialState = await waitForStableXhsPageState(page, signal);
  if (initialState !== "ready") {
    return { state: initialState, stage: "explore", url: await page.evaluate<string>("location.href", signal) };
  }

  const searchControlTimeoutMs = options.searchControlTimeoutMs ?? 8000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const searchControlStartedAt = Date.now();
  let lastBlockedState: XhsPageState | undefined;
  let blockedRepeats = 0;
  let focused = false;
  do {
    if (signal?.aborted) throw new Error("Xiaohongshu UI search aborted");
    const state = await page.call(detectXhsPageState, [], signal);
    if (state !== "ready") {
      if (state === lastBlockedState) blockedRepeats++;
      else {
        lastBlockedState = state;
        blockedRepeats = 1;
      }
      if (blockedRepeats >= 3) {
        return { state, stage: "explore", url: await page.evaluate<string>("location.href", signal) };
      }
    } else {
      lastBlockedState = undefined;
      blockedRepeats = 0;
      focused = await page.call(focusVisibleXhsSearchInput, [], signal);
      if (focused) break;
    }
    if (pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() - searchControlStartedAt < searchControlTimeoutMs);

  if (!focused) {
    const finalState = await waitForStableXhsPageState(page, signal, {
      settleMs: 0,
      intervalMs: pollIntervalMs,
      consecutive: 3,
      maxSamples: 3,
    });
    return {
      state: finalState === "ready" ? "navigation-failed" : finalState,
      stage: "explore",
      url: await page.evaluate<string>("location.href", signal),
    };
  }
  await page.insertText(query, signal);
  const clicked = await page.click(".input-button .search-icon, .input-button", signal);
  if (!clicked) await page.pressKey("Enter", signal);

  const startedAt = Date.now();
  lastBlockedState = undefined;
  blockedRepeats = 0;
  while (Date.now() - startedAt < 12000) {
    if (signal?.aborted) throw new Error("Xiaohongshu UI search aborted");
    const state = await page.call(detectXhsPageState, [], signal);
    const url = await page.evaluate<string>("location.href", signal);
    if (state !== "ready") {
      if (state === lastBlockedState) blockedRepeats++;
      else {
        lastBlockedState = state;
        blockedRepeats = 1;
      }
      if (blockedRepeats >= 3) return { state, stage: "after-submit", url };
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    } else {
      lastBlockedState = undefined;
      blockedRepeats = 0;
    }

    if (url.includes("/search_result")) {
      const structured = await page.call(extractXhsSearchState, [], signal);
      const domCount = await page.evaluate<number>("document.querySelectorAll('section.note-item').length", signal);
      if ((structured.available && structured.feeds.length > 0) || domCount > 0) {
        return { state: "ready", stage: "after-submit", url };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    state: "navigation-failed",
    stage: "after-submit",
    url: await page.evaluate<string>("location.href", signal),
  };
}
