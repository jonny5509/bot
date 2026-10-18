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
  const valid = readings.filter(x => x.ok);
  if (!valid.length) return { ok: false, message: "No service adapter returned a timer. The provider adapters must be implemented before live sync can work.", readings, changes: [] };
  const targetSeconds = Math.max(...valid.map(x => x.seconds));
  return {
    ok: true, targetSeconds, target: duration(targetSeconds), readings,
    changes: valid.map(x => ({
      service: x.service, beforeSeconds: x.seconds, before: duration(x.seconds),
      addSeconds: targetSeconds - x.seconds, add: duration(targetSeconds - x.seconds),
      target: duration(targetSeconds),
      allowed: targetSeconds - x.seconds <= Number(settings.maxAdditionSeconds)
    }))
  };
}

async function runSync() {
  if (busy) return { ok: false, message: "A synchronization is already in progress." };
  busy = true;
  try {
    const p = await previewSync();
    if (!p.ok) {
      await logEvent("warning", "Sync skipped: no readable timers.", {
        reason: p.message, services: p.readings.map(x => x.service + ": " + (x.error || "unknown")).join("; ")
      });
      return p;
    }
    const adapters = new Map(getAdapters(loadSettings()).map(a => [a.service, a]));
    const results = [];
    for (const change of p.changes) {
      if (change.addSeconds === 0) { results.push({ ...change, status: "already-matched" }); continue; }
      if (!change.allowed) {
        const result = { ...change, status: "skipped-limit", error: "Addition exceeds configured maximum" };
        results.push(result);
        await logEvent("warning", change.service + ": addition skipped by safety limit.", { before: change.before, requestedAddition: change.add, target: change.target });
        continue;
      }
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
    await logEvent("info", "Sync finished.", { target: p.target, changed: count, evaluated: results.length });
    return { ok: true, target: p.target, readings: p.readings, changes: results };
  } finally { busy = false; }
}
module.exports = { previewSync, runSync };
