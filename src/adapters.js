// Provider adapters for Chaster, Chastify, and EmlaLock.
// Chaster writes stay disabled until its public UpdateTimeDto is documented.
const API = "https://api.chaster.app";
const CHASTIFY = "https://chastify.net/api/apps/v1";
const EMLA = "https://api.emlalock.com";

async function responseJson(response, service) {
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  if (!response.ok || body?.error) {
    throw new Error(String(body?.message || body?.error || service + " API HTTP " + response.status).slice(0, 250));
  }
  return body;
}
async function chaster(token, endpoint) {
  return responseJson(await fetch(API + endpoint, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" }
  }), "Chaster");
}
function lockObject(v) { return v?.lock || v?.data || v; }
function chasterEnd(lock) {
  for (const v of [lock?.endDate, lock?.endDateTime, lock?.timer?.endDate, lock?.session?.endDate]) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    let ms = typeof v === "number" ? v : Date.parse(v);
    if (typeof v === "number" && ms < 1e12) ms *= 1000;
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  throw new Error("Chaster response has no recognized end date; no changes made.");
}
async function chastify(token, lockId, endpoint, options = {}) {
  if (!/^[a-f0-9]{24}$/i.test(lockId || "")) throw new Error("Use the exact 24-character hexadecimal Chastify lock._id.");
  return responseJson(await fetch(CHASTIFY + endpoint, { ...options, headers: {
    Authorization: "Bearer " + token, "x-chastify-lock-id": lockId, Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {})
  }}), "Chastify");
}
function chastifyTime(body, id) {
  if (String(body?.lock?._id || "").toLowerCase() !== id.toLowerCase()) throw new Error("Chastify response lock ID does not match the configured lock.");
  const n = body?.lockData?.timeRemainingSeconds;
  if (n == null || !Number.isFinite(Number(n))) throw new Error("Chastify does not expose this lock's remaining time.");
  return Math.max(0, Math.floor(Number(n)));
}
function emlaUrl(path, userId, apiKey, extra = {}) {
  const url = new URL(path, EMLA);
  url.searchParams.set("userid", userId);
  url.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
  return url;
}
async function emlalock(userId, apiKey, path, extra = {}) {
  // EmlaLock requires query-string credentials; redact fetch failures too because
  // some runtimes include the requested URL (and API key) in network errors.
  let response;
  try {
    response = await fetch(emlaUrl(path, userId, apiKey, extra), {
      headers: { Accept: "application/json" }
    });
  } catch {
    throw new Error("EmlaLock request failed before a response was received; request details are redacted.");
  }
  return responseJson(response, "EmlaLock");
}
function emlaEnd(body) {
  const n = Number(body?.chastitysession?.enddate);
  if (!Number.isFinite(n) || n <= 0) throw new Error("EmlaLock returned no active-session end date.");
  return n;
}
function getAdapters(settings) {
  const all = settings.integrations || {};
  return ["chaster", "chastify", "emlalock"].map(service => {
    const c = all[service] || {};
    const configured = service === "emlalock"
      ? Boolean(c.enabled && c.apiToken && c.userId)
      : Boolean(c.enabled && c.apiToken && c.timerId);
    if (service === "chaster") return {
      service, configured, canAddTime: false,
      async readRemainingSeconds() {
        if (!configured) throw new Error("Chaster is not configured");
        return Math.max(0, Math.floor((chasterEnd(lockObject(await chaster(c.apiToken, "/locks/" + encodeURIComponent(c.timerId)))) - Date.now()) / 1000));
      },
      async addSeconds() { throw new Error("Chaster time additions are disabled until its request schema is verified."); }
    };
    if (service === "chastify") return {
      service, configured, canAddTime: true,
      async readRemainingSeconds() {
        if (!configured) throw new Error("Chastify is not configured");
        return chastifyTime(await chastify(c.apiToken, c.timerId, "/session"), c.timerId);
      },
      async addSeconds(seconds) {
        if (!configured || !Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("Chastify addition must be a positive whole number of seconds.");
        await chastify(c.apiToken, c.timerId, "/lock/apply-time", {
          method: "POST", body: JSON.stringify({ deltaSeconds: seconds })
        });
      }
    };
    return {
      service, configured, canAddTime: true,
      async readRemainingSeconds() {
        if (!configured) throw new Error("EmlaLock is not configured");
        return Math.max(0, Math.floor(emlaEnd(await emlalock(c.userId, c.apiToken, "/info")) - Date.now() / 1000));
      },
      async addSeconds(seconds) {
        if (!configured || !Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("EmlaLock addition must be a positive whole number of seconds.");
        await emlalock(c.userId, c.apiToken, "/add", { value: seconds });
      }
    };
  });
}
module.exports = { getAdapters };
