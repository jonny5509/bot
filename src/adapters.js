// Provider adapters are deliberately fail-closed until verified against current official APIs.
// Never guess endpoints or silently report a successful timer change.
class AdapterNotReadyError extends Error {
  constructor(service) {
    super(service + " API adapter is not implemented yet. No timer changes were sent.");
    this.name = "AdapterNotReadyError";
  }
}
function getAdapters(settings) {
  return ["chaster", "chastify", "emlalock"].map(service => {
    const config = settings.integrations[service];
    return {
      service,
      configured: Boolean(config && config.enabled && config.apiToken && config.timerId),
      async readRemainingSeconds() { throw new AdapterNotReadyError(service); },
      async addSeconds(_seconds) { throw new AdapterNotReadyError(service); }
    };
  });
}
module.exports = { getAdapters };
