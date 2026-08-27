import assert from "node:assert/strict";
import test from "node:test";
import type { CdpPageLease } from "../src/host/browser/types.ts";
import {
  focusVisibleXhsSearchInput,
  navigateXhsSearchViaUi,
} from "../src/host/sources/xiaohongshu/ui-search.ts";

test("XHS UI search focuses the current visible feed textarea and ignores the hidden helper", () => {
  const saved = {
    document: (globalThis as any).document,
    getComputedStyle: (globalThis as any).getComputedStyle,
    HTMLInputElement: (globalThis as any).HTMLInputElement,
    HTMLTextAreaElement: (globalThis as any).HTMLTextAreaElement,
  };

  class FakeInputElement {}
  class FakeTextAreaElement {
    disabled = false;
    readOnly = false;
    tabIndex = 0;
    focusCount = 0;
    attributes = new Map<string, string>();
    style = { display: "block", visibility: "visible", pointerEvents: "auto", opacity: "1" };
    rect = { width: 800, height: 40 };
    focus() {
      this.focusCount++;
      (globalThis as any).document.activeElement = this;
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    getBoundingClientRect() {
      return this.rect;
    }
  }

  const hiddenHelper = new FakeTextAreaElement();
  hiddenHelper.tabIndex = -1;
  hiddenHelper.attributes.set("aria-hidden", "true");
  hiddenHelper.style.opacity = "0.00001";
  const feedSearch = new FakeTextAreaElement();
  let exposeDedicatedSelector = true;

  try {
    (globalThis as any).HTMLInputElement = FakeInputElement;
    (globalThis as any).HTMLTextAreaElement = FakeTextAreaElement;
    (globalThis as any).getComputedStyle = (element: FakeTextAreaElement) => element.style;
    (globalThis as any).document = {
      activeElement: null,
      querySelectorAll: (selector: string) => {
        if (selector === "textarea#search-input-in-feeds") return exposeDedicatedSelector ? [feedSearch] : [];
        if (selector === "textarea[placeholder*='搜索']") return [hiddenHelper, feedSearch];
        return [];
      },
    };

    assert.equal(focusVisibleXhsSearchInput(), true);
    assert.equal((globalThis as any).document.activeElement, feedSearch);

    exposeDedicatedSelector = false;
    (globalThis as any).document.activeElement = null;
    assert.equal(focusVisibleXhsSearchInput(), true);
    assert.equal(hiddenHelper.focusCount, 0);
    assert.equal((globalThis as any).document.activeElement, feedSearch);
  } finally {
    (globalThis as any).document = saved.document;
    (globalThis as any).getComputedStyle = saved.getComputedStyle;
    (globalThis as any).HTMLInputElement = saved.HTMLInputElement;
    (globalThis as any).HTMLTextAreaElement = saved.HTMLTextAreaElement;
  }
});

function fakePage(
  initialState: "ready" | "login-wall" = "ready",
  afterSubmitState: "ready" | "login-wall" = "ready",
  focusReadyAfter = 1,
) {
  const calls = { navigated: [] as string[], query: "", submitted: false, focusAttempts: 0 };
  const page = {
    navigate: async (url: string) => { calls.navigated.push(url); },
    waitForLoad: async () => {},
    waitForSelector: async () => {},
    call: async (fn: { name?: string }, args?: unknown[]) => {
      if (fn.name === "detectXhsPageState") return calls.submitted ? afterSubmitState : initialState;
      if (fn.name === "focusVisibleXhsSearchInput") {
        calls.focusAttempts++;
        return calls.focusAttempts >= focusReadyAfter;
      }
      if (fn.name === "extractXhsSearchState") {
        return { available: true, feeds: [{ id: "note" }] };
      }
      return undefined;
    },
    insertText: async (text: string) => { calls.query = text; },
    click: async () => {
      calls.submitted = true;
      return true;
    },
    pressKey: async () => { calls.submitted = true; },
    evaluate: async (expression: string) => {
      if (expression === "location.href") {
        return calls.submitted
          ? "https://www.xiaohongshu.com/search_result?keyword=DeepSeek%20Harness"
          : "https://www.xiaohongshu.com/explore";
      }
      if (expression.includes("section.note-item")) return 1;
      return undefined;
    },
  } as unknown as CdpPageLease;
  return { page, calls };
}

test("XHS UI search navigates through explore and enters only the cleaned topic query", async () => {
  const { page, calls } = fakePage();
  const result = await navigateXhsSearchViaUi(page, "DeepSeek Harness");

  assert.deepEqual(calls.navigated, ["https://www.xiaohongshu.com/explore"]);
  assert.equal(calls.query, "DeepSeek Harness");
  assert.equal(calls.submitted, true);
  assert.equal(result.state, "ready");
  assert.equal(result.stage, "after-submit");
  assert.match(result.url, /search_result/);
});

test("XHS UI search labels a post-submit login wall as search-stage restricted", async () => {
  const { page } = fakePage("ready", "login-wall");
  const result = await navigateXhsSearchViaUi(page, "DeepSeek Harness");

  assert.equal(result.state, "login-wall");
  assert.equal(result.stage, "after-submit");
});

test("XHS UI search waits for the hydrated search input to become interactive", async () => {
  const { page, calls } = fakePage("ready", "ready", 3);
  const result = await navigateXhsSearchViaUi(page, "DeepSeek Harness", undefined, {
    searchControlTimeoutMs: 100,
    pollIntervalMs: 1,
  });

  assert.equal(calls.focusAttempts, 3);
  assert.equal(calls.query, "DeepSeek Harness");
  assert.equal(result.state, "ready");
  assert.equal(result.stage, "after-submit");
});

test("XHS UI search reports an interactive-control timeout as an explore navigation failure", async () => {
  const { page, calls } = fakePage("ready", "ready", Number.POSITIVE_INFINITY);
  const result = await navigateXhsSearchViaUi(page, "DeepSeek Harness", undefined, {
    searchControlTimeoutMs: 0,
    pollIntervalMs: 0,
  });

  assert.equal(calls.submitted, false);
  assert.equal(result.state, "navigation-failed");
  assert.equal(result.stage, "explore");
});

test("XHS UI search stops at a visible login wall instead of clicking or timing out", async () => {
  const { page, calls } = fakePage("login-wall");
  const result = await navigateXhsSearchViaUi(page, "DeepSeek Harness");

  assert.equal(result.state, "login-wall");
  assert.equal(result.stage, "explore");
  assert.equal(calls.query, "");
  assert.equal(calls.submitted, false);
});
