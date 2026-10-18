// Windows DPAPI-backed secret storage. Secrets are encrypted for the current Windows user.
const { spawnSync } = require("node:child_process");

function runPowerShell(script) {
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script
  ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "Windows DPAPI operation failed").trim());
  return (result.stdout || "").trim();
}

function encryptSecret(plain) {
  if (!plain) return "";
  if (process.platform !== "win32") throw new Error("DPAPI secret encryption requires Windows.");
  const input = Buffer.from(String(plain), "utf8").toString("base64");
  const script = "$b='" + input + "'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); $s=ConvertTo-SecureString $p -AsPlainText -Force; ConvertFrom-SecureString $s";
  return "dpapi:" + runPowerShell(script);
}

function decryptSecret(value) {
  if (!value) return "";
  if (!String(value).startsWith("dpapi:")) return String(value); // legacy migration path
  if (process.platform !== "win32") throw new Error("DPAPI secret decryption requires the same Windows user.");
  const cipher = String(value).slice(6).replace(/'/g, "''");
  const script = "$s=ConvertTo-SecureString '" + cipher + "'; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { $v=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }";
  const b64 = runPowerShell(script);
  return Buffer.from(b64, "base64").toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
