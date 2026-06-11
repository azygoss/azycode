import { formatLocalReview, formatLocalReviewJson, localReview } from "./local-review.js";

export function recommendSecurityTests(files = []) {
  const checks = new Set();
  if (files.some((file) => /\.(js|mjs|cjs|ts|tsx)$/.test(file))) checks.add("npm test");
  if (files.some((file) => /(^|\/)package\.json$/.test(file))) {
    checks.add("npm install");
    checks.add("npm test");
  }
  if (files.some((file) => /\.github\/workflows\//.test(file))) checks.add("review CI workflow permissions");
  if (files.some((file) => /(^|\/)(src|lib|bin)\//.test(file))) checks.add("npm run check");
  if (!checks.size) checks.add("npm run check");
  return [...checks];
}

export function buildSecurityReview(cwd = process.cwd()) {
  const local = localReview(cwd);
  const testRecommendations = recommendSecurityTests(local.files);
  return {
    ...local,
    testRecommendations,
    highSeverityCount: local.findings.filter((finding) => finding.severity === "high").length
  };
}

export function securityReviewPrompt(review) {
  const findings = review.findings.map((finding) => {
    const evidence = finding.evidence ? ` evidence=${finding.evidence}` : "";
    const file = finding.file ? ` file=${finding.file}` : "";
    return `- [${finding.severity}] ${finding.title}${file}${evidence}`;
  }).join("\n");
  return [
    "Perform a security-focused review of the current repository changes.",
    "Prioritize injection flaws, authentication and authorization gaps, secret exposure, SSRF, path traversal, unsafe parsing, command execution, missing validation, and unsafe defaults.",
    "",
    `Changed files (${review.files.length}): ${review.files.join(", ") || "(none)"}`,
    "",
    "Local heuristic findings:",
    findings || "(none)",
    "",
    `Recommended verification commands: ${review.testRecommendations.join(", ")}`,
    "",
    "Return findings ordered by severity with file paths, evidence, exploitability notes, remediation steps, and the tests that should be run before merge.",
    "If no issues are found, state residual risk and unrun checks clearly."
  ].join("\n");
}

export function formatSecurityReview(review) {
  const lines = [
    "Security Review",
    `changedFiles: ${review.files.length}`,
    `diffStats: +${review.stats.added} -${review.stats.removed}`,
    `highSeverityFindings: ${review.highSeverityCount ?? 0}`,
    `recommendedTests: ${review.testRecommendations.join(", ")}`
  ];
  if (!review.findings.length) {
    lines.push("findings: none");
    return lines.join("\n");
  }
  lines.push("findings:");
  for (const item of review.findings) {
    const loc = item.file ? ` file=${item.file}` : item.line ? ` line≈${item.line}` : "";
    lines.push(`- [${item.severity}] ${item.title}${loc}`);
    lines.push(`  ${item.detail}`);
    if (item.evidence) lines.push(`  evidence: ${item.evidence}`);
  }
  return lines.join("\n");
}

export function formatSecurityReviewJson(review) {
  return {
    ...formatLocalReviewJson(review),
    testRecommendations: review.testRecommendations,
    highSeverityCount: review.highSeverityCount ?? 0
  };
}

export function formatSecurityReviewCombined(localReviewResult, modelOutput = "") {
  const sections = [formatSecurityReview(localReviewResult)];
  if (modelOutput) {
    sections.push("", "Model security review:", modelOutput);
  }
  return sections.join("\n");
}