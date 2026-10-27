# ESP32 standalone port

Native Arduino firmware for an **ESP32-WROOM-32 / ESP32 Dev Module**. It replaces the Windows/Node.js runtime with a dashboard served directly by the board.

## Features

- Hosted responsive dashboard for comparing Chaster, Chastify, and EmlaLock timers.
- Preview-only comparison and explicit manual synchronization.
- Optional Discord bot using a verified TLS WebSocket gateway, with `/timesync status`, `start`, `stop`, `preview`, and `run` slash commands.
- Optional Discord incoming-webhook notifications for manual/automatic sync results.
- Optional automatic sync, disabled on every reboot. When enabled, checks at the next wall-clock 10-minute boundary (:00, :10, :20, :30, :40, :50), then every boundary; missed slots are skipped.
- HTTPS API calls with certificate-bundle validation. The device clock must be synchronized for TLS validation.
- Provider errors are redacted; EmlaLock API keys are not included in serial logs or error messages.
- A configured maximum addition, defaulting to 2,592,000 seconds (30 days).

## Build and flash

1. Install [PlatformIO Core](https://platformio.org/install/cli) or the VS Code PlatformIO extension.
2. From this directory, copy src/secrets.example.h to src/secrets.h.
3. Edit src/secrets.h and set your Wi-Fi SSID/password and a unique dashboard password of at least 16 characters.
4. Connect the ESP32-WROOM-32 over USB.
5. Run pio run -t upload, then pio device monitor -b 115200.
6. Open the dashboard URL printed in the serial monitor (usually http://192.168.x.x/) and sign in using DASHBOARD_USER and DASHBOARD_PASSWORD.
7. Configure each provider's credentials and timer ID in **Settings**, save, and use **Refresh preview**. Only use **Synchronize now** after verifying all three readings and additions.
8. Optional Discord setup: create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications), add the bot to your server with `bot` and `applications.commands` scopes, then enter the bot token, application ID, and server (guild) ID in Settings. Add an incoming webhook URL too if you want notifications. Save and reboot the ESP32 so the bot reconnects and registers slash commands. Keep the bot token and webhook URL secret. Use a guild ID for fast command registration and to scope commands to your own server.

The firmware stores provider settings in ESP32 NVS via Preferences. This is not an encrypted backup format and is not equivalent to Windows DPAPI. Never commit src/secrets.h or share firmware/build artifacts that contain it. For sensitive deployments, enable ESP32 flash encryption and secure boot in an appropriate ESP-IDF production workflow; protect physical access to the board.

## Safety behavior

A sync is blocked unless all three integrations are enabled, configured, and readable. The target is the longest remaining time; the only proposed changes are positive differences from that target. Every proposed addition is checked against the configured limit **before any write is attempted**. A zero difference is a no-op. The firmware serializes sync operations and never retries a provider write automatically because the original request may have changed the timer even if its response was lost.

If one write fails after another provider has accepted its change, the result explicitly warns that the timers may be partially synchronized. Check the provider sites and verify actual timer values before deciding whether to retry manually.

The maximum addition is limited to 30 days in this build. Automatic mode is not persisted, so it is always OFF after reboot. No provider credentials are included in the dashboard settings response.

## Network and credential warnings

The dashboard uses HTTP Basic Authentication over plain HTTP. It is intended only for a trusted private LAN: Basic Auth does **not** encrypt traffic. Do not port-forward it, expose it to the internet, or use it on an untrusted Wi-Fi network. Use a unique dashboard password. Provider API keys are stored in device NVS; flash encryption is recommended for real-world deployment. A physical attacker with access to the board may be able to extract stored data unless hardware security features are configured.

TLS server certificate validation is enabled for provider REST calls and Discord REST calls; the Discord gateway trusts the Google Trust Services root certificates included in firmware. Do not change TLS to an insecure mode. Certificate authorities can change over time, so update the firmware trust roots if Discord changes its chain. If provider calls fail immediately after boot, wait for NTP time synchronization and retry the read/preview. The ESP32 must have working internet access and a correct clock.

## Compatibility notes / validation status

This is a firmware port, not a drop-in execution of the original Node.js app. Discord slash commands and outgoing webhook notifications are implemented on the ESP32. The Windows DPAPI vault and encrypted passphrase backup/restore are not ported; credentials are stored in device NVS. The dashboard is hosted by the ESP32 and the device performs API calls directly.

Provider endpoints and response shapes follow the original project's adapters. Real credentials and live provider timers have not been exercised in this environment, and this firmware has not been compiled against physical hardware here. Test with provider documentation and, where possible, non-critical timers before enabling automatic mode. Verify all timer values after each live sync.
