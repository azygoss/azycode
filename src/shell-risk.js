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

export function classifyShellCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { level: "safe-read", reason: "empty command" };

  const levels = [];
  if (SECRET_RISK_PATTERNS.some((p) => p.test(cmd))) levels.push("secret-risk");
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd))) levels.push("destructive");
  if (NETWORK_PATTERNS.some((p) => p.test(cmd))) levels.push("network");
  if (BUILD_TEST_PATTERNS.some((p) => p.test(cmd))) levels.push("build-test");
  if (SAFE_READ_PATTERNS.some((p) => p.test(cmd))) levels.push("safe-read");

  const priority = ["secret-risk", "destructive", "network", "build-test", "safe-read"];
  const level = priority.find((item) => levels.includes(item)) || "build-test";
  return { level, levels: [...new Set(levels)], command: cmd };
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