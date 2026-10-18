const { loadSettings } = require("./config");
const { getAdapters } = require("./adapters");
const { logEvent } = require("./logger");
let busy = false;

function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60), sec = s % 60;
  return [d && d + "d", h && h + "h", m && m + "m", sec + "s"].filter(Boolean).join(" ");
}

async function previewSync() {
  const settings = loadSettings();
  const adapters = getAdapters(settings);
  const readings = await Promise.all(adapters.map(async a => {
    if (!a.configured) return { service: a.service, ok: false, error: "Not configured" };
    try {
      const seconds = await a.readRemainingSeconds();
      if (!Number.isInteger(seconds) || seconds < 0) throw new Error("Invalid time returned");
      return { service: a.service, ok: true, seconds };
    } catch (e) { return { service: a.service, ok: false, error: e.message }; }
  }));
  const allConfigured = adapters.length === 3 && adapters.every(a => a.configured);
  const allReadable = readings.length === 3 && readings.every(x => x.ok);
  if (!allConfigured || !allReadable) {
    return {
      ok: false, writable: false,
      message: "Cannot compare timers until all three integrations are enabled, configured, and readable. No changes were sent.",
      readings, changes: []
    };
  }
  const targetSeconds = Math.max(...readings.map(x => x.seconds));
  const blockedServices = adapters.filter(a => a.canAddTime !== true).map(a => a.service);
  const writable = blockedServices.length === 0;
  const writeBlockReason = blockedServices.map(service => service === "chaster"
    ? "Chaster time-writing is disabled because the published API request schema does not define a safe request body"
    : service + " time-writing is disabled in this build").join("; ");
  const changes = readings.map(x => ({
    service: x.service, beforeSeconds: x.seconds, before: duration(x.seconds),
    addSeconds: targetSeconds - x.seconds, add: duration(targetSeconds - x.seconds),
    target: duration(targetSeconds),
    allowed: targetSeconds - x.seconds <= Number(settings.maxAdditionSeconds)
  }));
  return {
    ok: true, writable, blockedServices, targetSeconds, target: duration(targetSeconds), readings, changes,
    message: writable
      ? "All integrations are readable and support writes."
      : "Preview only. Live synchronization is blocked: " + writeBlockReason + ". No timer changes will be sent."
  };
}

async function runSync() {
  if (busy) return { ok: false, message: "A synchronization is already in progress." };
  busy = true;
  try {
    const p = await previewSync();
    if (!p.ok || !p.writable) {
      await logEvent("warning", "Sync skipped: comparison unavailable or at least one provider is read-only.", {
        reason: p.message, services: (p.readings || []).map(x => x.service + ": " + (x.error || (x.ok ? "readable" : "unknown"))).join("; ")
      });
      return { ...p, ok: false, message: p.message + " No timer changes were sent." };
    }
    // Preflight every addition before making any mutation. This avoids a
    // predictable partial sync when one timer exceeds the configured safety cap.
    const overLimit = p.changes.filter(change => change.addSeconds > 0 && !change.allowed);
    if (overLimit.length) {
      await logEvent("warning", "Sync blocked by safety limit; no timer changes were sent.", {
        target: p.target,
        blockedServices: overLimit.map(x => x.service).join(", "),
        maximumAdditionSeconds: Number(loadSettings().maxAdditionSeconds)
      });
      return {
        ...p, ok: false,
        message: "Sync blocked: one or more additions exceed the configured maximum. No timer changes were sent.",
        changes: p.changes.map(change => ({ ...change, status: change.addSeconds > 0 && !change.allowed ? "blocked-limit" : "not-started" }))
      };
    }
    const adapters = new Map(getAdapters(loadSettings()).map(a => [a.service, a]));
    const results = [];
    for (const change of p.changes) {
      if (change.addSeconds === 0) { results.push({ ...change, status: "already-matched" }); continue; }
      try {
        await adapters.get(change.service).addSeconds(change.addSeconds);
        results.push({ ...change, status: "changed" });
        await logEvent("success", change.service + ": timer synchronized.", {
          previousTime: change.before, addedTime: change.add, targetTime: change.target,
          result: "Adapter accepted the change request"
        });
      } catch (e) {
        results.push({ ...change, status: "failed", error: e.message });
        await logEvent("error", change.service + ": timer change failed.", {
          previousTime: change.before, requestedAddition: change.add, targetTime: change.target, error: e.message
        });
      }
    }
    const count = results.filter(x => x.status === "changed").length;
    const failures = results.filter(x => x.status === "failed");
    const successful = failures.length === 0;
    await logEvent(successful ? "info" : "error", successful
      ? "Sync finished."
      : "Sync finished with failures; some timers may already have changed.",
    { target: p.target, changed: count, failed: failures.length, evaluated: results.length });
    return {
      ok: successful, target: p.target, readings: p.readings, changes: results,
      message: successful
        ? "Synchronization requests completed. Verify provider timers to confirm the resulting values."
        : "One or more provider writes failed. Some timers may already have changed; inspect each result and verify all timers before retrying."
    };
  } finally { busy = false; }
}
module.exports = { previewSync, runSync };
