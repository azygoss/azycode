/** Zero-dependency shell command risk classifier. */

export const SHELL_RISK_LEVELS = ["safe-read", "build-test", "network", "destructive", "secret-risk"];

const SAFE_READ_PATTERNS = [
  /^\s*pwd\s*$/i,
  /^\s*ls\b/i,
  /^\s*ll\b/i,
  /^\s*dir\s*$/i,
  /^\s*cat\s+/i,
  /^\s*head\s+/i,
  /^\s*tail\s+/i,
  /^\s*wc\s+/i,
  /^\s*find\s+.+\s+-type\s+f\b/i,
  /^\s*git\s+status\b/i,
  /^\s*git\s+diff\b/i,
  /^\s*git\s+log\b/i,
  /^\s*git\s+show\b/i,
  /^\s*git\s+branch\b/i,
  /^\s*git\s+rev-parse\b/i,
  /^\s*node\s+--test\b/i,
  /^\s*npm\s+test\b/i,
  /^\s*npm\s+run\s+(test|check|lint|typecheck)\b/i,
  /^\s*pnpm\s+(test|run\s+(test|check|lint))\b/i,
  /^\s*yarn\s+(test|run\s+(test|check|lint))\b/i,
  /^\s*pytest\b/i,
  /^\s*cargo\s+test\b/i,
  /^\s*go\s+test\b/i,
  /^\s*make\s+test\b/i
];

const BUILD_TEST_PATTERNS = [
  /^\s*npm\s+run\s+/i,
  /^\s*npm\s+test\b/i,
  /^\s*pnpm\s+run\b/i,
  /^\s*yarn\s+run\b/i,
  /^\s*node\s+--test\b/i,
  /^\s*pytest\b/i,
  /^\s*cargo\s+(build|test|check)\b/i,
  /^\s*go\s+(build|test)\b/i,
  /^\s*make\s+(build|test|check)\b/i,
  /^\s*tsc\b/i,
  /^\s*eslint\b/i,
  /^\s*prettier\b/i
];

const NETWORK_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\s+-/i,
  /\bnetcat\b/i,
  /\bnpm\s+install\b/i,
  /\bnpm\s+i\b/i,
  /\bpnpm\s+install\b/i,
  /\byarn\s+add\b/i,
  /\byarn\s+install\b/i,
  /\bpip\s+install\b/i,
  /\bcargo\s+install\b/i,
  /\bgo\s+get\b/i,
  /\bapt(-get)?\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bgit\s+clone\b/i,
  /\bgit\s+pull\b/i,
  /\bgit\s+fetch\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\b/i
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|-[a-zA-Z]*r[a-zA-Z]*\s+|-[a-zA-Z]*f[a-zA-Z]*r|-[a-zA-Z]*r[a-zA-Z]*f)/i,
  /\brm\s+-rf\b/i,
  /\brm\s+-fr\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\btruncate\s+-s\s+0\b/i,
  /\b>\s*\/dev\/sd/i,
  /\bdrop\s+database\b/i,
  /\bDROP\s+TABLE\b/i
];

const SECRET_RISK_PATTERNS = [
  /\bprintenv\b/i,
  /\benv\b/i,
  /\bexport\b/i,
  /\bcat\s+.*\.env/i,
  /\bgrep\s+.*(?:api[_-]?key|secret|token|password)/i,
  /\btype\s+.*\.env/i,
  /\becho\s+\$[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD)/i,
  /\baws\s+configure\s+list\b/i,
  /\bgcloud\s+auth\b/i,
  /\bkubectl\s+get\s+secret/i,
  /\bopenssl\s+.*-pass/i
];

/**
 * Paths that are dangerous to write to. A redirect targeting any of these is
 * treated as destructive regardless of the source command.
 */
const DANGEROUS_REDIRECT_TARGETS = [
  /^\/etc\//i,
  /^\/var\/log\//i,
  /^\/dev\/(?!null\b)/i, // /dev/null is harmless; other devices are not
  /^\/proc\//i,
  /^\/sys\//i,
  /^\/boot\//i,
  /^\/usr\/(local\/)?bin\//i,
  /^\/root\/\./i,
  /^\/etc\/(?:passwd|shadow|sudoers)/i
];

/**
 * Detect shell metacharacter operators in a command: pipes `|`, output
 * redirection `>`/`>>`, input redirection `<`, and command substitution
 * backticks/`$()`. We deliberately keep this lexical — full shell parsing is
 * out of scope — but it is enough to stop `cat x > /etc/passwd` slipping past
 * a `cat`-based safe-read rule.
 *
 * @returns {{ pipe: boolean, redirect: boolean, redirectTargets: string[], inputRedirect: boolean, substitution: boolean }}
 */
export function detectShellOperators(command) {
  const cmd = String(command || "");
  const pipe = /\|/.test(cmd);
  // `>` or `>>` not preceded by a digit that is part of an fd merge like `2>&1`
  const redirectMatch = cmd.match(/(?:\d)?(>>|>)\s*(\S+)/g) || [];
  const redirect = redirectMatch.length > 0;
  const redirectTargets = redirectMatch
    .map((segment) => segment.replace(/^\d?>>?[\s]*/, "").trim())
    .filter((t) => t && t !== "&" && !/^&\d/.test(t));
  const inputRedirect = /[^<]\s*</.test(cmd) || /^\s*</.test(cmd);
  const substitution = /`/.test(cmd) || /\$\(/.test(cmd);
  return { pipe, redirect, redirectTargets, inputRedirect, substitution };
}

/** Whether a redirect target points at a sensitive system location. */
function isDangerousRedirectTarget(target) {
  const t = String(target || "").trim().replace(/^["']|["']$/g, "");
  if (!t || t === "/dev/null") return false;
  return DANGEROUS_REDIRECT_TARGETS.some((re) => re.test(t));
}

/** Classify a single command segment (no operators) by risk level. */
function classifySegment(segment) {
  const seg = String(segment || "").trim();
  if (!seg) return { level: "build-test", reason: "empty segment" };
  const levels = [];
  if (SECRET_RISK_PATTERNS.some((p) => p.test(seg))) levels.push("secret-risk");
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(seg))) levels.push("destructive");
  if (NETWORK_PATTERNS.some((p) => p.test(seg))) levels.push("network");
  if (BUILD_TEST_PATTERNS.some((p) => p.test(seg))) levels.push("build-test");
  if (SAFE_READ_PATTERNS.some((p) => p.test(seg))) levels.push("safe-read");
  const priority = ["secret-risk", "destructive", "network", "build-test", "safe-read"];
  const level = priority.find((item) => levels.includes(item)) || "build-test";
  return { level, levels };
}

export function classifyShellCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { level: "safe-read", reason: "empty command" };

  const operators = detectShellOperators(cmd);

  // Split on pipe `|` (but not `||`) and classify each segment independently,
  // then take the most dangerous segment. This catches `ls | grep token`.
  const segments = operators.pipe
    ? cmd.split(/\|\|/).length > 1
      ? [cmd] // `||` is a logical OR, not a pipeline; keep whole
      : cmd.split(/\|/).map((s) => s.trim()).filter(Boolean)
    : [cmd];

  const segmentResults = segments.map(classifySegment);
  const priority = ["secret-risk", "destructive", "network", "build-test", "safe-read"];
  let level = "safe-read";
  let reason = "command classified";
  for (const segLevel of priority) {
    if (segmentResults.some((r) => r.level === segLevel)) {
      level = segLevel;
      break;
    }
  }

  // Redirection to a sensitive system path is destructive regardless of the
  // source command: `echo x > /etc/passwd` must never be auto-approved.
  if (operators.redirect && operators.redirectTargets.some(isDangerousRedirectTarget)) {
    level = "destructive";
    reason = "Redirect targets a sensitive system path";
  } else if (operators.redirect) {
    // Any output redirection changes a safe-read command into write-risk and
    // therefore must not stay at safe-read. Elevate to at least build-test.
    if (level === "safe-read") {
      level = "build-test";
      reason = "Output redirection present";
    }
  }

  if (operators.inputRedirect && level === "safe-read") {
    level = "build-test";
    reason = "Input redirection present";
  }

  if (operators.substitution) {
    // Command substitution can hide arbitrary execution; never safe-read.
    if (level === "safe-read") {
      level = "build-test";
      reason = "Command substitution present";
    }
  }

  const levels = [...new Set([...segmentResults.flatMap((r) => r.levels), level])];
  return { level, levels, command: cmd, operators };
}

export function evaluateShellPolicy(command, cfg = {}) {
  const classification = classifyShellCommand(command);
  const profile = cfg.permissionProfile || "normal";
  const shellPolicy = cfg.toolPolicy?.shell || "ask";
  const allowDestructive = Boolean(cfg.shellPolicy?.allowDestructive);
  const autoNetwork = Boolean(cfg.shellPolicy?.autoNetwork);
  const autoBuildTest = cfg.shellPolicy?.autoBuildTest !== false;

  const { level } = classification;

  if (level === "secret-risk") {
    return {
      decision: "ask",
      level,
      reason: "Command may expose secrets or environment variables; approval always required.",
      classification
    };
  }
  if (level === "destructive") {
    if (profile === "full-auto" && allowDestructive) {
      return { decision: "auto", level, reason: "Destructive command allowed by shellPolicy.allowDestructive.", classification };
    }
    return {
      decision: "deny",
      level,
      reason: "Destructive command blocked. Set shellPolicy.allowDestructive=true in full-auto to permit.",
      classification
    };
  }
  if (level === "network") {
    if (shellPolicy === "deny") {
      return { decision: "deny", level, reason: "Network command denied by shell tool policy.", classification };
    }
    if (autoNetwork) {
      return { decision: "auto", level, reason: "Network command auto-approved by shellPolicy.autoNetwork.", classification };
    }
    if (profile === "full-auto" && shellPolicy === "auto") {
      return { decision: "auto", level, reason: "Network command auto-approved in full-auto profile.", classification };
    }
    return { decision: "ask", level, reason: "Network command requires approval (shell auto does not imply network auto).", classification };
  }
  if (level === "build-test") {
    if (shellPolicy === "deny") {
      return { decision: "deny", level, reason: "Shell denied by tool policy.", classification };
    }
    if (shellPolicy === "auto" || autoBuildTest) {
      return { decision: "auto", level, reason: "Build/test command auto-approved.", classification };
    }
    if (profile === "trusted-workspace" || profile === "full-auto") {
      return { decision: "auto", level, reason: `Build/test auto-approved for profile ${profile}.`, classification };
    }
    return { decision: "ask", level, reason: "Build/test command requires approval in this profile.", classification };
  }
  if (level === "safe-read") {
    if (shellPolicy === "deny") {
      return { decision: "deny", level, reason: "Shell denied by tool policy.", classification };
    }
    return { decision: "auto", level, reason: "Safe read-only command auto-approved.", classification };
  }

  if (shellPolicy === "deny") {
    return { decision: "deny", level: "build-test", reason: "Shell denied by tool policy.", classification };
  }
  if (shellPolicy === "auto") {
    return { decision: "auto", level: "build-test", reason: "Shell auto-approved by tool policy.", classification };
  }
  return { decision: "ask", level: "build-test", reason: "Shell command requires approval.", classification };
}