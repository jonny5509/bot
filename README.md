# Time Sync Bot

Windows-friendly local dashboard and Discord bot for comparing timer remaining times across Chaster, Chastify, and EmlaLock.

## Current status

- **Chastify adapter implemented:** reads the selected lock through the user-wide Developer API and adds a positive time delta using `POST /api/apps/v1/lock/apply-time`. Use the exact 24-character hexadecimal `lock._id` and a key with `locks:read` and `locks:write`. The endpoint is non-idempotent, so the bot does not automatically retry time changes. Official docs: https://docs.chastify.net/developer-api/external-api-programs/
- **EmlaLock adapter implemented:** reads `chastitysession.enddate` from `GET /info` and adds seconds through `GET /add`. The API requires the User ID and API key as HTTPS query parameters; the code redacts request/network errors to avoid logging the key. Official docs: https://about.emlalock.com/docs/api/
- **Chaster adapter implemented:** reads the selected lock and adds a positive time delta with `POST /locks/{lockId}/update-time`, sending `{"duration": seconds}` with a Bearer token. The duration is expressed in seconds. Official API: https://api.chaster.app/api
- **Live synchronization can write to all three providers** when all integrations are enabled, configured, readable, and the computed additions pass the configured safety limit. The bot computes each difference against the longest timer and sends only that delta; verify provider timers after a real sync.

These API integrations are committed but have **not yet been tested with real provider credentials**. Treat them as implementation-in-progress, not production-ready.

Mocked adapter tests are included. After installing dependencies, run `npm test` to check request paths, request bodies, time units, and validation of Chaster additions. The tests do not replace testing with your own provider credentials.

## Automatic schedule

- Automatic mode is **stopped by default** every time the app launches.
- When you manually start it, the first automatic check is scheduled for the **next local clock boundary** divisible by 10 minutes, then at :00, :10, :20, :30, :40, and :50 for the rest of the day and overnight.
- The scheduler recalculates against the wall clock after each check. If a check runs long, missed boundaries are skipped instead of running catch-up checks.
- The schedule continues 24/7 only while the app process is running and the computer is awake and connected. It does not run while the computer is shut down or asleep.
- Stopping automatic mode cancels the next scheduled check. Manual checks remain available.

## Windows quick start

1. Double-click `Start Time Sync.bat`.
2. If Node.js 20 or newer is missing, the launcher downloads and installs the latest official Node.js LTS release automatically. Windows may ask for permission to install software.
3. The launcher installs project dependencies on first run, starts the local server, and opens `http://127.0.0.1:3000`.
4. In Setup, follow the links beside each field to create or locate credentials:
   - **Discord bot:** create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Get the bot token under **Bot** and the Application ID under **General Information**. Enable [Developer Mode](https://support.discord.com/hc/en-us/articles/206346498) to copy server and channel IDs.
   - **Chaster:** request API access using the [getting-started guide](https://docs.chaster.app/api/basics/getting-started/), then generate a [developer token](https://docs.chaster.app/api/public-api/developer-token/). Use the lock ID for the intended lock.
   - **Chastify:** create a user-wide Developer API key and review required scopes in the [official External API guide](https://docs.chastify.net/developer-api/external-api-programs/). Use the exact 24-character hexadecimal `lock._id` for the intended lock.
   - **EmlaLock:** find your User ID and API key in your EmlaLock account Settings; see the [API guide](https://about.emlalock.com/wiki/api/) and [API reference](https://about.emlalock.com/docs/api/). No separate lock ID is needed.

## Security

Secrets are encrypted for the current Windows user using Windows DPAPI. Never commit credentials or `.env` files. Keep the dashboard on localhost and do not port-forward it. EmlaLock's documented API requires the key in the HTTPS query string; the adapter never logs the URL and redacts network errors. Chastify time-change requests are not retried automatically.

## Settings backup and restore

Open **Setup → Settings backup and restore** to download an encrypted JSON backup or restore one later. Backups include all saved settings and credentials. They are encrypted with AES-256-GCM using a key derived from your passphrase with scrypt; use a passphrase of at least 12 characters. The passphrase is never saved by the app. Without it, the backup cannot be restored.

Keep the backup file and passphrase separate and private. Restore replaces the current settings and leaves automatic sync stopped. Secrets are encrypted again with Windows DPAPI for the Windows user running the app, so a backup can be moved to another PC/account as long as you know the passphrase. Restart the app after restoring to apply Discord bot settings.

## Factory reset

Open **Setup → Factory reset** and confirm twice. This stops automatic sync and deletes local settings, encrypted credentials, local logs, and `.env`. It cannot delete Discord messages already sent or revoke provider credentials; revoke those separately if needed.
