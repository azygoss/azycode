let _lastProviderFailure = null;

export function recordProviderFailure({ provider, status = null, message, path = null }) {
  _lastProviderFailure = {
    at: new Date().toISOString(),
    provider: String(provider || ""),
    status,
    path,
    message: String(message || "").slice(0, 500)
  };
  return _lastProviderFailure;
}

export function getLastProviderFailure() {
  return _lastProviderFailure ? { ..._lastProviderFailure } : null;
}

export function clearProviderFailure() {
  _lastProviderFailure = null;
}