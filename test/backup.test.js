const test = require("node:test");
const assert = require("node:assert/strict");
const { createSettingsBackup, restoreSettingsBackup } = require("../src/backup");

const settings = {
  discordLogChannelId: "channel-id",
  discordClientId: "client-id",
  discordGuildId: "guild-id",
  discordBotToken: "discord-secret",
  maxAdditionSeconds: 2592000,
  integrations: {
    chaster: { enabled: true, apiToken: "chaster-secret", timerId: "lock-a", userId: "" },
    chastify: { enabled: true, apiToken: "chastify-secret", timerId: "0123456789abcdef01234567", userId: "" },
    emlalock: { enabled: false, apiToken: "emla-secret", timerId: "", userId: "user-id" }
  }
};
const passphrase = "a strong test passphrase";

test("encrypted settings backup round-trips settings including secrets", () => {
  const backup = createSettingsBackup(settings, passphrase);
  assert.equal(backup.format, "timesync-settings-backup");
  assert.equal(JSON.stringify(backup).includes("chaster-secret"), false);
  assert.deepEqual(restoreSettingsBackup(backup, passphrase), settings);
});

test("backup uses a fresh salt and IV each time", () => {
  const a = createSettingsBackup(settings, passphrase);
  const b = createSettingsBackup(settings, passphrase);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("wrong passphrase and modified ciphertext are rejected", () => {
  const backup = createSettingsBackup(settings, passphrase);
  assert.throws(() => restoreSettingsBackup(backup, "wrong passphrase"), /Could not decrypt/);
  const tampered = { ...backup, ciphertext: Buffer.from("tampered").toString("base64") };
  assert.throws(() => restoreSettingsBackup(tampered, passphrase), /Could not decrypt|invalid or too large/);
});

test("unsupported and incomplete backups are rejected", () => {
  assert.throws(() => restoreSettingsBackup({ format: "other" }, passphrase), /not a supported/);
  const invalid = createSettingsBackup({ ...settings, integrations: { chaster: {} } }, passphrase);
  assert.throws(() => restoreSettingsBackup(invalid, passphrase), /incomplete or invalid/);
});
