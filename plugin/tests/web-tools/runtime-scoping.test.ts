import assert from "node:assert/strict";
import test from "node:test";
import { BraveQuotaManager } from "../../packages/plugin-host/src/web-tools/host/providers/brave.ts";

test("BraveQuotaManager scopes cache and persist callbacks per instance and releases on dispose", async () => {
  let persistWrites: Array<{ key: string; limit?: number }> = [];
  const manager1 = new BraveQuotaManager((key, snapshot) => {
    persistWrites.push({ key, limit: snapshot.limit });
  });

  manager1.seed("key-1", {
    supported: true,
    authoritative: true,
    unit: "requests",
    source: "response_header",
    fetchedAt: 1000,
    limit: 15000,
    remaining: 14000,
  });

  const snap = await manager1.getQuota("key-1");
  assert.equal(snap.limit, 15000);
  assert.equal(snap.remaining, 14000);

  // Record a new response header snapshot
  const headers = new Headers({
    "x-ratelimit-limit": "1, 20000",
    "x-ratelimit-remaining": "1, 19500",
  });
  manager1.recordFromHeaders("key-1", headers);

  assert.equal(persistWrites.length, 1);
  assert.equal(persistWrites[0].limit, 20000);

  // Dispose manager1 -> persist callback is released and won't write again
  manager1.dispose();
  manager1.recordFromHeaders("key-1", new Headers({ "x-ratelimit-limit": "1, 30000" }));
  assert.equal(persistWrites.length, 1); // No new write after dispose
});
