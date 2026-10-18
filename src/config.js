const fs = require("node:fs");
const path = require("node:path");
const { encryptSecret, decryptSecret } = require("./vault");

const dataDir = path.join(process.cwd(), "data");
const settingsPath = path.join(dataDir, "settings.json");
const defaults = {
  discordLogChannelId: "",
  discordClientId: "",
  discordGuildId: "",
  discordBotToken: "",
  maxAdditionSeconds: 2592000,
  integrations: {
    chaster: { enabled: false, apiToken: "", timerId: "", userId: "" },
    chastify: { enabled: false, apiToken: "", timerId: "", userId: "" },
    emlalock: { enabled: false, apiToken: "", timerId: "", userId: "" }
  }
};

function ensureDir() { fs.mkdirSync(dataDir, { recursive: true }); }

function loadSettings() {
  ensureDir();
  if (!fs.existsSync(settingsPath)) return structuredClone(defaults);
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const merged = {
      ...structuredClone(defaults), ...raw,
      integrations: { ...structuredClone(defaults.integrations), ...(raw.integrations || {}) }
    };
    merged.discordBotToken = decryptSecret(merged.discordBotToken || "");
    for (const key of Object.keys(merged.integrations)) {
      const item = merged.integrations[key] || {};
      merged.integrations[key] = { enabled: false, apiToken: "", timerId: "", userId: "", ...item };
      merged.integrations[key].apiToken = decryptSecret(merged.integrations[key].apiToken || "");
    }
    return merged;
  } catch (err) {
    console.error("Could not load settings. If this file was encrypted by another Windows user, restore it under the original account.", err.message);
    return structuredClone(defaults);
  }
}

function saveSettings(settings) {
  ensureDir();
  const stored = structuredClone(settings);
  stored.discordBotToken = encryptSecret(stored.discordBotToken || "");
  for (const key of Object.keys(stored.integrations)) {
    stored.integrations[key].apiToken = encryptSecret(stored.integrations[key].apiToken || "");
  }
  fs.writeFileSync(settingsPath, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
}

function publicSettings(s) {
  return {
    discordLogChannelId: s.discordLogChannelId || "",
    discordClientId: s.discordClientId || "",
    discordGuildId: s.discordGuildId || "",
    discordTokenConfigured: Boolean(s.discordBotToken),
    maxAdditionSeconds: s.maxAdditionSeconds,
    integrations: Object.fromEntries(Object.entries(s.integrations).map(([name, v]) => [name, {
      enabled: Boolean(v.enabled), timerId: v.timerId || "", userId: v.userId || "", tokenConfigured: Boolean(v.apiToken)
    }]))
  };
}

module.exports = { loadSettings, saveSettings, publicSettings };
