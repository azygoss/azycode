import { MODES, normalizeMode, saveConfig } from "./config.js";
import { info } from "./logger.js";

export function createModeRuntime(initialMode, { cfg = null, onModeChange = null } = {}) {
  let current = normalizeMode(initialMode);
  let dirty = false;

  return {
    getMode() {
      return current;
    },
    consumeModeChange() {
      if (!dirty) return null;
      dirty = false;
      return current;
    },
    setMode(nextMode, { persist = false, reason = "" } = {}) {
      const next = normalizeMode(nextMode);
      if (!MODES.includes(next)) {
        throw new Error(`Invalid mode: ${nextMode}. Use one of: ${MODES.join(", ")}`);
      }
      const previous = current;
      current = next;
      dirty = true;
      if (persist && cfg) {
        cfg.mode = next;
        saveConfig(cfg);
      }
      info(`Mode switched from ${previous} to ${next}${persist ? " (persisted)" : ""}${reason ? `: ${reason}` : ""}`);
      const payload = { mode: next, previous, persist: Boolean(persist), reason: reason ? String(reason) : "" };
      if (onModeChange) onModeChange(payload);
      return payload;
    }
  };
}