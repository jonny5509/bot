const fs = require("node:fs");
const path = require("node:path");
const { EmbedBuilder } = require("discord.js");
const { loadSettings } = require("./config");

const dataDir = path.join(process.cwd(), "data");
const logFile = path.join(dataDir, "events.jsonl");
let client = null;
let recent = [];

function setDiscordClient(value) { client = value; }

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
module.exports = { setDiscordClient, logEvent, getRecentLogs, clearRecentLogs };
