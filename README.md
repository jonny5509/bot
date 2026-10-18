# Time Sync Bot

Windows-friendly local dashboard and Discord bot for synchronizing timer remaining times across Chaster, Chastify, and EmlaLock.

## Integration status

- Chastify's user-wide Developer API supports reading a selected session and applying a positive time delta with `POST /api/apps/v1/lock/apply-time` and `{"deltaSeconds":600}` for ten minutes. Requests are non-idempotent and must not be blindly retried. See https://docs.chastify.net/developer-api/external-api-programs/.
- EmlaLock supports reading session data from `/info` and adding seconds with `/add`; its API key and user ID are query parameters, so request URLs must never be logged. See https://about.emlalock.com/docs/api/.
- Chaster reading is present, but time addition remains disabled. The published OpenAPI schema exposes `POST /locks/{lockId}/update-time` but currently defines `UpdateTimeDto` with no properties, so the write body cannot safely be guessed. See https://api.chaster.app/api-json.

The Chastify and EmlaLock adapter changes have not yet been committed. Live synchronization remains blocked until the adapters are implemented and tested, Chaster's write contract is confirmed, and all three timers can be read and safely updated. Automatic mode should remain stopped by default.

## Windows quick start

1. Double-click `Start Time Sync.bat`.
2. If Node.js 20 or newer is missing, the launcher downloads and installs the latest official Node.js LTS release automatically. Windows may ask for permission to install software.
3. The launcher installs project dependencies on first run, starts the local server, and opens `http://127.0.0.1:3000`.
4. Configure API credentials only in the local Setup page. Never commit credentials or `.env` files.

## Security

Secrets should be encrypted for the current Windows user using Windows DPAPI. Keep the dashboard on localhost and do not port-forward it. EmlaLock's documented API requires its API key in the HTTPS query string; never log the full request URL.

## Factory reset

Open **Setup → Factory reset** and confirm twice. This stops automatic sync and deletes local settings, encrypted credentials, local logs, and `.env`. It cannot delete Discord messages already sent or revoke provider credentials; revoke those separately if needed.
