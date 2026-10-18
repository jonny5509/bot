# Time Sync Bot

Windows-friendly local dashboard and Discord bot for time synchronization across Chaster, Chastify, and EmlaLock.

## Status

Chaster has a read-only Public API adapter that attempts to read a configured lock's end date using a Developer Token. Chaster time additions remain disabled until the exact update-time request schema is verified. Chastify and EmlaLock adapters are not implemented, so synchronization is not yet ready for live use. Automatic checks run every 10 minutes only after you start them; automatic mode is stopped on every app launch.

## Windows quick start

1. Double-click `Start Time Sync.bat`.
2. If Node.js 20 or newer is missing, the launcher downloads and installs the latest official Node.js LTS release automatically. Windows may ask for permission to install software.
3. The launcher installs project dependencies on first run, starts the local server, and opens `http://127.0.0.1:3000`.
4. Configure the Chaster Developer Token and lock ID in Setup. The Chaster connection is currently read-only; live synchronization is not enabled yet.

Credentials should be encrypted for the current Windows user using Windows DPAPI; never commit credentials or `.env` files. Keep the dashboard on localhost and do not port-forward it.

## Factory reset

Open **Setup → Factory reset** and confirm twice. This stops automatic sync, disconnects the Discord client, and deletes the local `data/` directory (saved encrypted credentials and local logs) plus `.env`. Restart the app to begin fresh. It cannot delete Discord messages already sent or revoke credentials with Chaster, Chastify, EmlaLock, or Discord; revoke those separately if needed.
