// Chaster Public API integration. Writes intentionally remain disabled until the
// UpdateTimeDto request shape is verified against the live OpenAPI schema.
const API_BASE = "https://api.chaster.app";

class AdapterNotReadyError extends Error {
  constructor(service, message) {
    super(message || service + " API adapter is not ready. No timer changes were sent.");
    this.name = "AdapterNotReadyError";
  }
}

async function chasterRequest(token, endpoint, options = {}) {
  const response = await fetch(API_BASE + endpoint, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const bodyText = await response.text();
  let body;
  try { body = bodyText ? JSON.parse(bodyText) : null; }
  catch { body = null; }
  if (!response.ok) {
    const message = body && (body.message || body.error) || ("Chaster API returned HTTP " + response.status);
    throw new Error(String(message).slice(0, 300));
  }
  return body;
}

function unwrapLock(value) {
  if (!value || typeof value !== "object") return null;
  if (value.lock && typeof value.lock === "object") return value.lock;
  if (value.data && typeof value.data === "object") return value.data;
  return value;
}

function endDateFromLock(lock) {
  const candidates = [
    lock && lock.endDate,
    lock && lock.endDateTime,
    lock && lock.timer && lock.timer.endDate,
    lock && lock.session && lock.session.endDate
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" || typeof candidate === "number") {
      const ms = typeof candidate === "number" ? candidate : Date.parse(candidate);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  throw new Error("Could not find a supported endDate field in the Chaster lock response. No changes were made.");
}

function getAdapters(settings) {
  return ["chaster", "chastify", "emlalock"].map(service => {
    const config = settings.integrations[service];
    const configured = Boolean(config && config.enabled && config.apiToken && config.timerId);
    if (service === "chaster") {
      return {
        service,
        configured,
        async readRemainingSeconds() {
          if (!configured) throw new Error("Chaster is not configured");
          const value = await chasterRequest(config.apiToken, "/locks/" + encodeURIComponent(config.timerId));
          const lock = unwrapLock(value);
          const endDate = endDateFromLock(lock);
          return Math.max(0, Math.floor((endDate - Date.now()) / 1000));
        },
        async addSeconds(_seconds) {
          throw new AdapterNotReadyError("Chaster", "Chaster timer reading is implemented, but adding time is disabled until the exact update-time request schema is verified. No timer changes were sent.");
        }
      };
    }
    return {
      service,
      configured,
      async readRemainingSeconds() { throw new AdapterNotReadyError(service); },
      async addSeconds(_seconds) { throw new AdapterNotReadyError(service); }
    };
  });
}
module.exports = { getAdapters };
