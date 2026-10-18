const test = require("node:test");
const assert = require("node:assert/strict");
const { getAdapters } = require("../src/adapters");

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

test("Chastify reads the pinned lock and sends one positive delta", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const lockId = "0123456789abcdef01234567";
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/session")) {
      return response({ lock: { _id: lockId }, lockData: { timeRemainingSeconds: 7200 } });
    }
    return response({ remainingSecondsBefore: 7200, remainingSecondsAfter: 7800 });
  };
  const adapter = getAdapters({ integrations: {
    chaster: {}, emlalock: {},
    chastify: { enabled: true, apiToken: "test-token", timerId: lockId }
  }}).find(x => x.service === "chastify");
  assert.equal(await adapter.readRemainingSeconds(), 7200);
  await adapter.addSeconds(600);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers["x-chastify-lock-id"], lockId);
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), { deltaSeconds: 600 });
});

test("EmlaLock reads Unix seconds and adds seconds without exposing API key in errors", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: new URL(String(url)), options });
    if (calls.length === 1) return response({ chastitysession: { enddate: Math.floor(Date.now() / 1000) + 3600 } });
    return response({ user: {}, chastitysession: { enddate: Math.floor(Date.now() / 1000) + 4200 } });
  };
  const adapter = getAdapters({ integrations: {
    chaster: {}, chastify: {},
    emlalock: { enabled: true, userId: "user-test", apiToken: "secret-test" }
  }}).find(x => x.service === "emlalock");
  const remaining = await adapter.readRemainingSeconds();
  assert.ok(remaining > 3500 && remaining <= 3600);
  await adapter.addSeconds(600);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, "/add");
  assert.equal(calls[1].url.searchParams.get("userid"), "user-test");
  assert.equal(calls[1].url.searchParams.get("apikey"), "secret-test");
  assert.equal(calls[1].url.searchParams.get("value"), "600");
});

test("Chaster writes remain blocked until its update-time schema is verified", async () => {
  const adapter = getAdapters({ integrations: {
    chaster: { enabled: true, apiToken: "test-token", timerId: "test-lock" },
    chastify: {}, emlalock: {}
  }}).find(x => x.service === "chaster");
  assert.equal(adapter.canAddTime, false);
  await assert.rejects(() => adapter.addSeconds(60), /schema is verified/);
});
