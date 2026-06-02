import { stdout, stderr } from "node:process";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  reset: "\x1b[0m"
};

function resolveLevel() {
  const env = process.env.AZYCODE_LOG_LEVEL?.toLowerCase();
  if (env && LEVELS[env] !== undefined) return env;
  if (process.env.AZYCODE_DEBUG === "1" || process.env.AZYCODE_DEBUG === "true") return "debug";
  return "info";
}

function useColor() {
  if (process.env.NO_COLOR) return false;
  if (stdout?.isTTY) return true;
  return false;
}

function format(level, message) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (!useColor()) return `${prefix} ${message}`;
  return `${COLORS[level] || ""}${prefix}${COLORS.reset} ${message}`;
}

function log(level, message) {
  const threshold = LEVELS[resolveLevel()] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const out = level === "error" || level === "warn" ? stderr : stdout;
  out.write(`${format(level, message)}\n`);
}

export function debug(message) {
  log("debug", message);
}

export function info(message) {
  log("info", message);
}

export function warn(message) {
  log("warn", message);
}

export function error(message) {
  log("error", message);
}

export function getLevel() {
  return resolveLevel();
}

export function setLevel(level) {
  process.env.AZYCODE_LOG_LEVEL = level;
}
