const fs = require("node:fs");
const path = require("node:path");
const { EmbedBuilder } = require("discord.js");
const { loadSettings } = require("./config");

const dataDir = path.join(process.cwd(), "data");
const logFile = path.join(dataDir, "events.jsonl");
let client = null;
let recent = [];

function setDiscordClient(value) { client = value; }


async function sendWebhook(title, message, details = {}) {
  const url = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
  if (!url) return false;
  let parsed;
  try { parsed = new URL(url); } catch { console.error("Discord webhook URL is invalid."); return false; }
  if (parsed.protocol !== "https:" || !["discord.com", "www.discord.com", "canary.discord.com", "ptb.discord.com"].includes(parsed.hostname) || !parsed.pathname.startsWith("/api/webhooks/")) {
    console.error("Discord webhook URL must be an HTTPS Discord webhook URL."); return false;
  }
  const fields = Object.entries(details).slice(0, 8).map(([name, value]) => ({ name: String(name).slice(0, 256), value: String(value ?? "—").slice(0, 900) || "—", inline: true }));
  const failed = /fail|error|blocked/i.test(title + " " + message);
  const payload = { embeds: [{ title: String(title).slice(0, 256), description: String(message).slice(0, 3500), fields, timestamp: new Date().toISOString(), color: failed ? 0xD83C3E : 0x2E9D63 }] };
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    if (!response.ok) { console.error("Discord webhook delivery failed (HTTP " + response.status + ")."); return false; }
    return true;
  } catch (err) { console.error("Discord webhook delivery failed:", err.name === "TimeoutError" ? "timeout" : "network error"); return false; }
}

async function logEvent(level, message, details = {}) {
  const entry = { at: new Date().toISOString(), level, message, details };
  recent.unshift(entry);
  recent = recent.slice(0, 250);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");

  const settings = loadSettings();
  if (client && settings.discordLogChannelId) {
    try {
      const channel = await client.channels.fetch(settings.discordLogChannelId);
      if (channel && channel.isTextBased()) {
        const embed = new EmbedBuilder().setTitle("Time Sync · " + level.toUpperCase())
          .setDescription(String(message).slice(0, 4000)).setTimestamp(new Date(entry.at));
        const fields = Object.entries(details).slice(0, 20).map(([name, value]) => ({
          name: String(name).slice(0, 256), value: String(value ?? "—").slice(0, 1024) || "—", inline: true
        }));
        if (fields.length) embed.addFields(fields);
        await channel.send({ embeds: [embed] });
      }
    } catch (err) { console.error("Discord log delivery failed:", err.message); }
  }
  return entry;
}
function getRecentLogs() { return recent; }
function clearRecentLogs() { recent = []; }
module.exports = { setDiscordClient, logEvent, getRecentLogs, clearRecentLogs, sendWebhook };
