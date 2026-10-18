# Time Sync Bot

Windows-friendly local dashboard and Discord bot for comparing timer remaining times across Chaster, Chastify, and EmlaLock.

## Current status

- **Chastify adapter implemented:** reads the selected lock through the user-wide Developer API and adds a positive time delta using `POST /api/apps/v1/lock/apply-time`. Use the exact 24-character hexadecimal `lock._id` and a key with `locks:read` and `locks:write`. The endpoint is non-idempotent, so the bot does not automatically retry time changes. Official docs: https://docs.chastify.net/developer-api/external-api-programs/
- **EmlaLock adapter implemented:** reads `chastitysession.enddate` from `GET /info` and adds seconds through `GET /add`. The API requires the User ID and API key as HTTPS query parameters; the code redacts request/network errors to avoid logging the key. Official docs: https://about.emlalock.com/docs/api/
- **Chaster read adapter implemented; write adapter intentionally disabled:** the public OpenAPI schema lists `POST /locks/{lockId}/update-time`, but its `UpdateTimeDto` currently declares no properties. The request body cannot safely be guessed. Official schema: https://api.chaster.app/api-json
- **Live synchronization remains blocked** until Chaster's time-add request contract is clarified and all three services have been tested against real API responses. The dashboard can calculate differences once all three timers are readable, but it will not send any changes while one adapter is read-only.

These API integrations are committed but have **not yet been tested with real provider credentials**. Treat them as implementation-in-progress, not production-ready.

## Windows quick start

1. Double-click `Start Time Sync.bat`.
2. If Node.js 20 or newer is missing, the launcher downloads and installs the latest official Node.js LTS release automatically. Windows may ask for permission to install software.
3. The launcher installs project dependencies on first run, starts the local server, and opens `http://127.0.0.1:3000`.
4. In Setup, configure Chastify with its user-wide Developer API key and exact lock ID, EmlaLock with its User ID and API key, and Chaster with its Developer Token and lock ID.

Automatic checks run every 10 minutes only after you start them. Automatic mode is stopped by default on every app launch.

## Security

Secrets are encrypted for the current Windows user using Windows DPAPI. Never commit credentials or `.env` files. Keep the dashboard on localhost and do not port-forward it. EmlaLock's documented API requires the key in the HTTPS query string; the adapter never logs the URL and redacts network errors. Chastify time-change requests are not retried automatically.

## Factory reset

Open **Setup → Factory reset** and confirm twice. This stops automatic sync and deletes local settings, encrypted credentials, local logs, and `.env`. It cannot delete Discord messages already sent or revoke provider credentials; revoke those separately if needed.
