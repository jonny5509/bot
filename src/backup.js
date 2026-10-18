const crypto = require("node:crypto");

function deriveBackupKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32);
}
function createSettingsBackup(settings, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveBackupKey(passphrase, salt), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
  return {
    format: "timesync-settings-backup", version: 1, kdf: "scrypt", cipher: "aes-256-gcm",
    salt: salt.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64")
  };
}
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

module.exports = { createSettingsBackup, restoreSettingsBackup };
