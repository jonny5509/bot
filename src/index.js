require("dotenv").config();
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { loadSettings, saveSettings, publicSettings } = require("./config");
const { setDiscordClient, logEvent, getRecentLogs, clearRecentLogs } = require("./logger");
const { previewSync, runSync } = require("./sync");

const app = express();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const INTERVAL_MS = 10 * 60 * 1000;
let autoRunning = false; // Deliberately reset to STOPPED every time the app starts.
let interval = null, lastCheckAt = null, lastResult = null, discordClient = null;

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function getState() { return { autoRunning, intervalMinutes: 10, lastCheckAt, lastResult }; }
async function checkNow(source) {
  lastCheckAt = new Date().toISOString();
  lastResult = await runSync();
  await logEvent("info", "Synchronization check completed (" + source + ").", {
    successful: Boolean(lastResult.ok),
    changed: (lastResult.changes || []).filter(x => x.status === "changed").length
  });
  return lastResult;
}

// Schedule against wall-clock boundaries (:00, :10, :20, ...), rather than
// measuring ten minutes from app start or from the end of the last check.
function scheduleNextBoundary() {
  if (!autoRunning) return;
  const delay = INTERVAL_MS - (Date.now() % INTERVAL_MS);
  interval = setTimeout(async () => {
    interval = null;
    if (!autoRunning) return;
    try {
      await checkNow("automatic");
    } catch (e) {
      await logEvent("error", "Automatic check failed.", { error: e.message });
    }
    // Recompute from the clock after the check; if it ran long, skip missed
    // boundaries rather than launching overlapping catch-up checks.
    if (autoRunning) scheduleNextBoundary();
  }, delay);
}

function startScheduler() {
  if (autoRunning) return false;
  autoRunning = true;
  scheduleNextBoundary();
  logEvent("info", "Automatic sync started. First check will run at the next 10-minute clock boundary.", { interval: "10 minutes", schedule: "wall-clock boundaries" });
  return true;
}
function stopScheduler() {
  if (!autoRunning) return false;
  autoRunning = false;
  if (interval) clearTimeout(interval);
  interval = null;
  logEvent("info", "Automatic sync stopped.");
  return true;
}

app.get("/api/state", (_req, res) => res.json(getState()));
app.get("/api/logs", (_req, res) => res.json(getRecentLogs()));
app.get("/api/preview", async (_req, res) => {
  try { res.json(await previewSync()); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post("/api/start", (_req, res) => res.json({ ok: true, changed: startScheduler(), ...getState() }));
app.post("/api/stop", (_req, res) => res.json({ ok: true, changed: stopScheduler(), ...getState() }));
app.post("/api/sync", async (_req, res) => {
  try {
    const result = await checkNow("manual");
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get("/api/settings", (_req, res) => res.json(publicSettings(loadSettings())));

// Portable backups encrypt the complete settings object with a user-chosen
// passphrase. Restored secrets are re-encrypted with this Windows user's DPAPI.
function deriveBackupKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32);
}
function createSettingsBackup(settings, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveBackupKey(passphrase, salt), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
  return {
    format: "timesync-settings-backup",
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64")
  };
}
function restoreSettingsBackup(backup, passphrase) {
  if (!backup || backup.format !== "timesync-settings-backup" || backup.version !== 1 ||
      backup.kdf !== "scrypt" || backup.cipher !== "aes-256-gcm" ||
      !["salt", "iv", "tag", "ciphertext"].every(k => typeof backup[k] === "string")) {
    throw new Error("This is not a supported Time Sync Bot backup file.");
  }
  const salt = Buffer.from(backup.salt, "base64");
  const iv = Buffer.from(backup.iv, "base64");
  const tag = Buffer.from(backup.tag, "base64");
  const ciphertext = Buffer.from(backup.ciphertext, "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length > 65536) {
    throw new Error("Backup file is invalid or too large.");
  }
  let parsed;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveBackupKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("Could not decrypt backup. Check the passphrase and file.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !parsed.integrations || typeof parsed.integrations !== "object" ||
      !["chaster", "chastify", "emlalock"].every(k => parsed.integrations[k] && typeof parsed.integrations[k] === "object")) {
    throw new Error("Backup contents are incomplete or invalid.");
  }
  for (const key of ["discordLogChannelId", "discordClientId", "discordGuildId", "discordBotToken"]) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") throw new Error("Backup settings are invalid.");
  }
  if (parsed.maxAdditionSeconds !== undefined &&
      (!Number.isInteger(parsed.maxAdditionSeconds) || parsed.maxAdditionSeconds < 0 || parsed.maxAdditionSeconds > 365 * 86400)) {
    throw new Error("Backup maximum addition setting is invalid.");
  }
  for (const name of ["chaster", "chastify", "emlalock"]) {
    const v = parsed.integrations[name];
    if (typeof v.enabled !== "boolean" ||
        ["apiToken", "timerId", "userId"].some(k => v[k] !== undefined && typeof v[k] !== "string")) {
      throw new Error("Backup integration settings are invalid.");
    }
  }
  return parsed;
}
app.post("/api/backup", (req, res) => {
  const passphrase = req.body && req.body.passphrase;
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024) {
    return res.status(400).json({ ok: false, message: "Use a backup passphrase of at least 12 characters." });
  }
  try {
    res.json({ ok: true, backup: createSettingsBackup(loadSettings(), passphrase) });
  } catch {
    res.status(500).json({ ok: false, message: "Could not create settings backup." });
  }
});
app.post("/api/restore", async (req, res) => {
  const passphrase = req.body && req.body.passphrase;
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024) {
    return res.status(400).json({ ok: false, message: "Enter the backup passphrase (at least 12 characters)." });
  }
  try {
    const settings = restoreSettingsBackup(req.body.backup, passphrase);
    stopScheduler();
    saveSettings(settings);
    await logEvent("warning", "Settings restored from an encrypted backup. Automatic sync remains stopped.", {
      enabledIntegrations: Object.entries(settings.integrations).filter(([, v]) => v.enabled).map(([k]) => k).join(", ") || "none"
    });
    res.json({ ok: true, message: "Settings restored. Automatic sync is stopped. Restart the app to apply Discord bot settings." });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message || "Could not restore settings backup." });
  }
});
app.post("/api/factory-reset", async (_req, res) => {
  try {
    stopScheduler();
    if (discordClient) {
      try { await discordClient.destroy(); } catch {}
      discordClient = null;
      setDiscordClient(null);
    }
    const dataDir = path.join(process.cwd(), "data");
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), ".env"), { force: true });
    clearRecentLogs();
    lastCheckAt = null;
    lastResult = null;
    autoRunning = false;
    interval = null;
    res.json({ ok: true, message: "Factory reset complete. Local settings, encrypted credentials, and local logs were deleted. Automatic sync is stopped." });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Factory reset failed: " + e.message });
  }
});

app.post("/api/settings", async (req, res) => {
  const body = req.body || {};
  const settings = loadSettings();
  if (body.discordLogChannelId !== undefined) settings.discordLogChannelId = String(body.discordLogChannelId).trim().slice(0, 100);
  if (body.discordClientId !== undefined) settings.discordClientId = String(body.discordClientId).trim().slice(0, 100);
  if (body.discordGuildId !== undefined) settings.discordGuildId = String(body.discordGuildId).trim().slice(0, 100);
  if (body.discordBotToken && String(body.discordBotToken).trim()) settings.discordBotToken = String(body.discordBotToken).trim();
  if (body.clearDiscordBotToken === true) settings.discordBotToken = "";
  if (body.maxAdditionSeconds !== undefined) {
    const n = Number(body.maxAdditionSeconds);
    if (!Number.isInteger(n) || n < 0 || n > 365 * 86400) return res.status(400).json({ ok: false, message: "Maximum addition must be between 0 and 365 days." });
    settings.maxAdditionSeconds = n;
  }
  for (const name of ["chaster", "chastify", "emlalock"]) {
    const incoming = body.integrations && body.integrations[name];
    if (!incoming) continue;
    settings.integrations[name].enabled = Boolean(incoming.enabled);
    if (incoming.timerId !== undefined) settings.integrations[name].timerId = String(incoming.timerId).trim().slice(0, 200);
    if (incoming.userId !== undefined) settings.integrations[name].userId = String(incoming.userId).trim().slice(0, 100);
    if (typeof incoming.apiToken === "string" && incoming.apiToken.trim()) settings.integrations[name].apiToken = incoming.apiToken.trim();
    if (incoming.clearToken === true) settings.integrations[name].apiToken = "";
  }
  try {
    saveSettings(settings);
    await logEvent("info", "Setup settings saved.", {
      enabledIntegrations: Object.entries(settings.integrations).filter(([, v]) => v.enabled).map(([k]) => k).join(", ") || "none",
      discordTokenConfigured: Boolean(settings.discordBotToken)
    });
    res.json({ ok: true, message: "Saved. Restart the app to apply Discord bot token changes." });
  } catch (e) { res.status(500).json({ ok: false, message: "Could not save settings: " + e.message }); }
});

async function startDiscord() {
  const settings = loadSettings();
  const token = settings.discordBotToken;
  const clientId = settings.discordClientId || process.env.DISCORD_CLIENT_ID;
  const guildId = settings.discordGuildId || process.env.DISCORD_GUILD_ID;
  if (!token || !clientId) {
    console.log("Discord is not configured yet. Add bot token and application ID in Setup/.env.");
    return;
  }
  try {
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
    setDiscordClient(discordClient);
    const command = new SlashCommandBuilder().setName("timesync").setDescription("Control the local time sync bot")
      .addSubcommand(s => s.setName("status").setDescription("Show automatic sync status"))
      .addSubcommand(s => s.setName("start").setDescription("Start checks every 10 minutes"))
      .addSubcommand(s => s.setName("stop").setDescription("Stop automatic checks"))
      .addSubcommand(s => s.setName("preview").setDescription("Preview timer differences"))
      .addSubcommand(s => s.setName("run").setDescription("Run a manual sync now"));
    const rest = new REST({ version: "10" }).setToken(token);
    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);
    await rest.put(route, { body: [command.toJSON()] });
    discordClient.on("interactionCreate", async interaction => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== "timesync") return;
      const sub = interaction.options.getSubcommand();
      if (sub === "status") return interaction.reply({ ephemeral: true, content: "Automatic mode: " + (autoRunning ? "RUNNING" : "STOPPED") + "\nInterval: 10 minutes\nSchedule: wall-clock boundaries (:00, :10, :20, ...)\nLast check: " + (lastCheckAt || "Never") });
      if (sub === "start") return interaction.reply({ ephemeral: true, content: startScheduler() ? "Automatic sync enabled. First check is at the next 10-minute clock boundary; then every 10 minutes." : "Automatic sync is already running." });
      if (sub === "stop") return interaction.reply({ ephemeral: true, content: stopScheduler() ? "Automatic sync stopped. Manual sync remains available." : "Automatic sync is already stopped." });
      if (sub === "preview") {
        await interaction.deferReply({ ephemeral: true });
        const p = await previewSync();
        const text = p.ok ? (p.writable ? "" : "PREVIEW ONLY — no timer changes sent.\n") + "Target: " + p.target + "\n" + p.changes.map(x => x.service + ": " + x.before + " → " + x.target + " (add " + x.add + ")").join("\n") : p.message;
        return interaction.editReply(text.slice(0, 1900));
      }
      if (sub === "run") {
        await interaction.deferReply({ ephemeral: true });
        const r = await checkNow("Discord manual");
        const text = r.ok ? "Manual sync result. Target: " + r.target + "\n" + (r.changes || []).map(x => x.service + ": " + x.status + (x.add ? " (add " + x.add + ")" : "") + (x.error ? " — " + x.error : "")).join("\n") : r.message;
        return interaction.editReply(text.slice(0, 1900));
      }
    });
    await discordClient.login(token);
    console.log("Discord bot connected.");
  } catch (e) {
    setDiscordClient(null);
    discordClient = null;
    console.error("Discord setup failed:", e.message);
  }
}

app.listen(PORT, HOST, async () => {
  console.log("Dashboard: http://" + HOST + ":" + PORT);
  await logEvent("info", "Time Sync Bot started. Automatic sync is STOPPED by default.");
  await startDiscord();
});
process.on("SIGINT", () => { stopScheduler(); if (discordClient) discordClient.destroy(); process.exit(0); });
process.on("SIGTERM", () => { stopScheduler(); if (discordClient) discordClient.destroy(); process.exit(0); });
