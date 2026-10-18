# ESP32 Timer Sync firmware (ESP32-WROOM-32 / DevKit V1)

This is a separate Arduino/PlatformIO firmware project. It does not replace the Windows app. It is an initial implementation scaffold and must be built and tested on the exact board before relying on it for real timer changes.

## Build and flash

- ESP32 DevKit V1 / ESP32-WROOM-32, 4 MB flash recommended.
- Install PlatformIO in VS Code.
- Obtain a PEM bundle of trusted public root certificates from Mozilla's official CA bundle source: https://curl.se/docs/caextract.html
- Save it as `firmware/data/ca.pem` (create the directory first).
- In PlatformIO, build the LittleFS filesystem image and upload it, then upload the firmware.
- Open Serial Monitor at 115200 baud.

TLS validation is mandatory. The firmware does not call `setInsecure()`; HTTPS fails if the CA file is missing or invalid. Keep the root bundle updated when rebuilding firmware.

## Wi-Fi setup

1. On first boot the ESP32 creates a Wi-Fi network named `TimerSync-Setup`.
2. Connect from your phone and open http://192.168.4.1.
3. Enter your home Wi-Fi SSID/password and save; the ESP32 restarts.
4. Open the local IP printed in Serial Monitor from a device on the same home Wi-Fi.
5. Set an admin PIN of at least 8 characters and enter provider lock IDs and credentials.

The setup AP is open during configuration; use it only in a private location and disconnect when finished. If Wi-Fi connection fails, the setup AP starts again.

## Behavior

- Dashboard readings and preview refresh every 30 seconds.
- Manual sync requires the dashboard PIN and a confirmation.
- Automatic mode is off by default and checks every 10 minutes after enabled.
- The whole run is blocked before writes if any timer is unreadable or an addition exceeds the configured maximum.
- A failed write stops the run. Non-idempotent writes are never retried automatically. If a request times out or a partial run fails, inspect all provider timers before manually trying again.
- After successful writes, the firmware rereads all timers. Verification failure is ambiguous; inspect provider sites manually.

## Security notes

- Keep the dashboard on the home LAN. Do not port-forward it or expose it publicly.
- The dashboard uses a PIN but local HTTP is not encrypted; use a trusted home network.
- Provider credentials are stored in ESP32 NVS via Preferences. **NVS is not automatically encrypted by this sketch.** For sensitive use, enable ESP32 flash encryption and secure boot through Espressif's official provisioning procedure. Physical access to an unencrypted device may expose credentials.
- EmlaLock's documented API places the key in an HTTPS query string. Firmware never prints request URLs or response bodies.
- NTP is required for correct time comparisons and TLS certificate validation.
- The existing Windows bot has more mature sync/error handling. Treat this firmware as unverified until it is tested on actual hardware and with your credentials.

## API contracts

- Chaster: `POST /locks/{lockId}/update-time`, JSON `{"duration": seconds}`.
- Chastify: `POST /api/apps/v1/lock/apply-time`, JSON `{"deltaSeconds": seconds}`, with configured lock ID header.
- EmlaLock: `GET /add?userid=...&apikey=...&value=seconds`.

Never disable TLS validation to work around certificate errors.
