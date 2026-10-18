# Time Sync Bot

Windows-friendly local dashboard and Discord bot for time synchronization across Chaster, Chastify, and EmlaLock.

## Status

This is a starter scaffold. Automatic checks run every 10 minutes only after you start them; automatic mode is stopped on every app launch. Manual sync is separate. Service API adapters must be implemented against each provider's current official API before live changes are enabled.

## Windows quick start

1. Install Node.js 20 or newer.
2. Double-click `Start Time Sync.bat`.
3. It installs dependencies on first run, starts the local server, and opens `http://127.0.0.1:3000`.
4. Configure integrations and Discord from Setup.

Credentials should be encrypted for the current Windows user using Windows DPAPI; never commit credentials or `.env` files. Keep the dashboard on localhost and do not port-forward it.
