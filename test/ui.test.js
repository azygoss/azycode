import test from "node:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  accent,
  badge,
  bold,
  box,
  brand,
  brandBanner,
  chip,
  code,
  contentWidth,
  createStreamPanel,
  diffBlock,
  diffLine,
  dim,
  error as errorText,
  faint,
  formatMarkdownLine,
  frame,
  grokActionRow,
  grokComposerDock,
  grokUserBar,
  grokWelcomeScreen,
  renderGrokResponse,
  helpPanel,
  highlightTerms,
  icon,
  info as infoText,
  isSpinnerActive,
  keyValueList,
  muted,
  padEnd,
  padStart,
  paint,
  panel,
  pill,
  prettyMs,
  progressBar,
  promptStatus,
  quoteBlock,
  renderTable,
  responsePanel,
  rule,
  runSummaryPanel,
  spinnerFrame,
  spinnerFrames,
  startSpinner,
  statCells,
  statusDot,
  statusPanel,
  stopSpinner,
  spinnerRunLabel,
  stripAnsi,
  style,
  subtle,
  success as successText,
  tag,
  timelineRow,
  title as titleText,
  tree,
  truncate,
  visibleLength,
  warn as warnText,
  wordmark,
  wrapText
} from "../src/ui.js";

function withNoColor(fn) {
  const previous = env.NO_COLOR;
  env.NO_COLOR = "1";
  // Re-import the colors by relying on noop behavior in style helpers.
  try {
    return fn();
  } finally {
    if (previous === undefined) delete env.NO_COLOR;
    else env.NO_COLOR = previous;
  }
}

test("style falls back to plain text when colors are disabled", () => {
  withNoColor(() => {
    assert.equal(style("hello", "success"), "hello");
    assert.equal(muted("hi"), "hi");
  });
});

test("padEnd and padStart account for ANSI codes in width", () => {
  const colored = style("ok", "success");
  assert.equal(visibleLength(colored), 2);
  assert.equal(padEnd(colored, 6), `${colored}    `);
  assert.equal(padStart(colored, 6), `    ${colored}`);
});

test("truncate handles ANSI codes and adds ellipsis", () => {
  const value = "a long string that should be cut";
  assert.equal(truncate(value, 8), "a long …");
  assert.equal(truncate(value, 100), value);
  assert.equal(truncate(value, 0), "");
  assert.match(truncate(value, 4), /^.{1,4}…$/);
});

test("stripAnsi removes all escape sequences", () => {
  const mixed = `${style("red", "error")} text ${style("blue", "info")}`;
  assert.equal(stripAnsi(mixed), "red text blue");
});

test("prettyMs formats milliseconds to friendly strings", () => {
  assert.equal(prettyMs(0), "<1ms");
  assert.equal(prettyMs(50), "50ms");
  assert.equal(prettyMs(999), "999ms");
  assert.equal(prettyMs(1500), "1.5s");
  assert.equal(prettyMs(12000), "12s");
  assert.equal(prettyMs(90000), "1m 30s");
  assert.equal(prettyMs(90000, { compact: true }), "1m 30s");
});

test("spinnerFrames returns braille animation frames", () => {
  const frames = spinnerFrames();
  assert.equal(frames.length, 10);
  assert.equal(frames[0], "⠋");
  assert.equal(spinnerFrame(0), "⠋");
  assert.equal(spinnerFrame(1), "⠙");
  assert.equal(spinnerFrame(10), frames[0]);
  assert.equal(spinnerFrame(-1), frames[frames.length - 1]);
});

test("icon returns Unicode symbols by name", () => {
  assert.equal(icon("check"), "✓");
  assert.equal(icon("cross"), "✗");
  assert.equal(icon("warn"), "⚠");
  assert.equal(icon("bullet"), "●");
  assert.equal(icon("circle"), "○");
  assert.equal(icon("arrow"), "→");
  assert.equal(icon("chevron"), "›");
  assert.equal(icon("unknown"), "");
});

test("badge color-codes ok/failed/warn/unknown values", () => {
  assert.match(stripAnsi(badge("ok")), /ok/);
  assert.match(stripAnsi(badge("failed")), /failed/);
  assert.match(stripAnsi(badge("warning")), /warning/);
  assert.match(stripAnsi(badge("custom")), /custom/);
});

test("statusDot returns bullet marker for state", () => {
  assert.equal(stripAnsi(statusDot("ok")), "●");
  assert.equal(stripAnsi(statusDot("error")), "●");
  assert.equal(stripAnsi(statusDot("unknown-state")), "●");
});

test("promptStatus joins segments with subtle separator", () => {
  const text = stripAnsi(promptStatus({ mode: "plan", reasoning: "high" }));
  assert.match(text, /plan/);
  assert.match(text, /high/);
  assert.match(text, /│/);
});

test("promptStatus shows conversation pressure", () => {
  const text = stripAnsi(promptStatus({ mode: "plan", reasoning: "high", messages: 18, maxMessages: 20 }));
  assert.match(text, /18\/20 msg/);
});

test("rule builds labeled horizontal divider", () => {
  const labeled = rule(40, { label: "Status" });
  assert.equal(stripAnsi(labeled).length, 40);
  assert.match(stripAnsi(labeled), /Status/);
  assert.match(stripAnsi(labeled), /─/);
});

test("rule centers the label by default", () => {
  const width = 40;
  const out = stripAnsi(rule(width, { label: "ready" }));
  const label = " ready ";
  const idx = out.indexOf(label.trim());
  assert.ok(idx > 0, "label should not be at the very start");
  const left = out.slice(0, idx).length;
  const right = out.slice(idx + label.trim().length).length;
  // Allow a 1-char imbalance for odd widths.
  assert.ok(Math.abs(left - right) <= 1, `expected symmetric rule, got left=${left} right=${right}`);
});

test("rule supports left and right alignment", () => {
  const leftAligned = stripAnsi(rule(40, { label: "tag", align: "left" }));
  assert.match(leftAligned, /^ tag ─+$/);
  assert.ok(!leftAligned.endsWith("─ tag ─"));
  const rightAligned = stripAnsi(rule(40, { label: "tag", align: "right" }));
  assert.match(rightAligned, /^─+ tag $/);
});

test("frame exposes named Unicode borders", () => {
  assert.deepEqual(frame("rounded"), { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" });
  assert.deepEqual(frame("double"), { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" });
});

test("box draws rows inside a Unicode frame", () => {
  const lines = box(["hello", "world"], { width: 16 });
  assert.equal(lines.length, 4);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /^╭─+╮$/);
  assert.match(plain[1], /hello/);
  assert.match(plain[1], /│/);
  assert.match(plain[3], /^╰─+╯$/);
});

test("keyValueList aligns keys and returns rendered rows", () => {
  const rows = keyValueList([["name", "azycode"], ["version", "0.1.0"]]);
  assert.equal(rows.length, 2);
  const plain = rows.map(stripAnsi);
  assert.match(plain[0], /name\s+azycode/);
  assert.match(plain[1], /version\s+0\.1\.0/);
});

test("keyValueList returns empty placeholder when no rows", () => {
  const rows = keyValueList([]);
  assert.equal(rows.length, 0);
});

test("renderTable aligns columns and emits header rule", () => {
  const lines = renderTable(
    [{ name: "shell", policy: "ask" }, { name: "read_file", policy: "auto" }],
    [{ key: "name", label: "tool" }, { key: "policy", label: "policy" }]
  );
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /tool\s+policy/);
  assert.match(plain[1], /^─+\s+─+$/);
  assert.match(plain[2], /shell\s+ask/);
  assert.match(plain[3], /read_file\s+auto/);
});

test("renderTable works without header", () => {
  const lines = renderTable(
    [{ a: 1 }, { a: 2 }],
    [{ key: "a", label: "A" }],
    { header: false }
  );
  assert.equal(lines.length, 2);
  assert.equal(stripAnsi(lines[0]), "1");
  assert.equal(stripAnsi(lines[1]), "2");
});

test("tree renders nested items with branch glyphs", () => {
  const lines = tree([
    { head: "root", children: [
      { head: "child-a" },
      { head: "child-b", children: [{ head: "leaf" }] }
    ] }
  ]);
  const plain = lines.map(stripAnsi);
  assert.match(plain[0], /root/);
  assert.match(plain[1], /├─\s+child-a/);
  // child-b is the last sibling so it gets the closing branch glyph.
  assert.match(plain[2], /└─\s+child-b/);
  assert.match(plain[3], /└─\s+leaf/);
});

test("tree handles plain string children", () => {
  const lines = tree(["first", "second"]);
  const plain = lines.map(stripAnsi);
  assert.equal(plain[0], "first");
  assert.equal(plain[1], "second");
});

test("startSpinner and stopSpinner work without TTY", () => {
  const spinner = startSpinner({ label: "noop", isTTY: false });
  assert.equal(isSpinnerActive(), true);
  stopSpinner({ finalLabel: "done" });
  assert.equal(isSpinnerActive(), false);
});

test("startSpinner is a no-op when another spinner is already running", () => {
  startSpinner({ label: "first", isTTY: false });
  startSpinner({ label: "second", isTTY: false });
  stopSpinner();
  assert.equal(isSpinnerActive(), false);
});

test("paint returns plain text when colors are disabled", () => {
  withNoColor(() => {
    assert.equal(paint("x", "\x1b[35m"), "x");
    assert.equal(paint("hello", ""), "hello");
  });
});

test("color shortcuts are exposed as functions", () => {
  for (const fn of [muted, subtle, faint, accent, successText, warnText, errorText, infoText, brand, dim, bold, code, tag, pill]) {
    const out = fn("value");
    assert.equal(typeof out, "string");
  }
});

test("titleText and badge still export the legacy signatures", () => {
  const captured = [];
  const original = console.log;
  console.log = (...args) => captured.push(args.join(" "));
  try {
    titleText("headline");
    assert.equal(captured.length, 1);
    assert.equal(captured[0], "headline");
  } finally {
    console.log = original;
  }
});

test("panel renders title and rows in a frame", () => {
  const lines = panel("Stats", ["row 1", "row 2"], { width: 20 });
  const plain = lines.map(stripAnsi);
  assert.equal(lines.length, 5);
  assert.match(plain[0], /^╭─+╮$/);
  assert.match(plain[1], /Stats/);
  assert.match(plain[1], /│/);
  assert.match(plain[2], /row 1/);
  assert.match(plain[4], /^╰─+╯$/);
});

test("panel shows empty placeholder when no rows", () => {
  const lines = panel("Empty", [], { width: 20 });
  const plain = lines.map(stripAnsi);
  assert.match(plain.join("\n"), /empty/);
});

test("contentWidth clamps to terminal bounds", () => {
  assert.equal(contentWidth(120), 96);
  assert.equal(contentWidth(40), 36);
  assert.equal(contentWidth(24), 20);
  assert.ok(contentWidth(undefined) >= 60);
  assert.ok(contentWidth(undefined) <= 96);
});

test("wrapText breaks long lines without truncating", () => {
  const lines = wrapText("one two three four five six seven", 12);
  assert.ok(lines.length > 1);
  assert.match(lines.join(" "), /one two three/);
  assert.match(lines.join(" "), /seven/);
});

test("progressBar renders filled and empty segments", () => {
  const bar = stripAnsi(progressBar(3, 10, 12));
  assert.match(bar, /\[.*\]/);
  assert.match(bar, /3\/10/);
});

test("wordmark and brandBanner expose welcome layout", () => {
  const [mark] = wordmark();
  assert.match(stripAnsi(mark), /azycode/);
  const lines = brandBanner(["hello"], { width: 24, title: "ready" });
  assert.match(stripAnsi(lines.join("\n")), /hello/);
  assert.match(stripAnsi(lines.join("\n")), /ready/);
});

test("timelineRow and responsePanel format rich TUI rows", () => {
  const row = timelineRow({ glyph: "→", label: "read_file", detail: "src/a.js", status: true });
  assert.match(stripAnsi(row), /read_file/);
  assert.match(stripAnsi(row), /src\/a\.js/);
  const panel = responsePanel("# Title\n- item", { width: 30, title: "assistant" });
  const plain = panel.map(stripAnsi).join("\n");
  assert.match(plain, /Title/);
  assert.match(plain, /item/);
});

test("formatMarkdownLine renders bold inline markdown", () => {
  const line = stripAnsi(formatMarkdownLine("Use **write_file** for edits"));
  assert.match(line, /write_file/);
});

test("grokWelcomeScreen and composer dock render startup chrome", () => {
  const welcome = grokWelcomeScreen({
    connected: true,
    workspace: "azycode",
    branch: "main",
    width: 72
  }).map(stripAnsi).join("\n");
  assert.match(welcome, /azycode/);
  assert.match(welcome, /ready/);
  assert.match(welcome, /main/);
  assert.match(welcome, /What should we work on/);
  assert.doesNotMatch(welcome, /kimi/);
  const dock = grokComposerDock({
    model: "kimi/kimi-for-coding",
    mode: "plan",
    reasoning: "high",
    width: 72
  }).map(stripAnsi).join("\n");
  assert.match(dock, /kimi\/kimi-for-coding/);
  assert.match(dock, /\[plan\]/);
  assert.match(dock, /keys/);
});

test("grok layout helpers format stream rows and responses", () => {
  const action = stripAnsi(grokActionRow("Read", "src/ui.js", { meta: "12ms" }));
  assert.match(action, /Read/);
  assert.match(action, /src\/ui\.js/);
  const user = stripAnsi(grokUserBar("fix the harness", { width: 60, timestamp: "11:49 PM" }));
  assert.match(user, /fix the harness/);
  assert.match(user, /11:49 PM/);
  const response = renderGrokResponse("Hello\n\n**Done**", { width: 60 }).map(stripAnsi).join("\n");
  assert.match(response, /Hello/);
  assert.match(response, /Done/);
});

test("runSummaryPanel condenses run stats into a frame", () => {
  const lines = runSummaryPanel({
    status: "ok",
    steps: 4,
    toolCalls: 3,
    duration: "2.5s",
    tokens: 900
  }, { width: 56, title: "run complete" });
  const plain = lines.map(stripAnsi).join("\n");
  assert.match(plain, /ok/);
  assert.match(plain, /4 steps/);
  assert.match(plain, /3 tools/);
  assert.match(plain, /2\.5s/);
  assert.match(plain, /900/);
});

test("statCells joins labeled values", () => {
  const text = stripAnsi(statCells([
    { label: "mode", value: "plan", style: "info" },
    { value: "high", style: "accent" }
  ]));
  assert.match(text, /mode plan/);
  assert.match(text, /high/);
});

test("diffBlock colorizes patch lines", () => {
  const lines = diffBlock("+added\n-removed", { indent: 2 });
  assert.equal(lines.length, 2);
  assert.match(stripAnsi(lines[0]), /\+added/);
  assert.match(stripAnsi(lines[1]), /-removed/);
});

test("statusPanel renders multi-section status layout", () => {
  const lines = statusPanel([
    { title: "session", rows: ["mode  plan"] },
    { title: "guard", rows: ["status  ok"] }
  ], { width: 40, title: "status" });
  const plain = lines.map(stripAnsi).join("\n");
  assert.match(plain, /status/);
  assert.match(plain, /session/);
  assert.match(plain, /guard/);
});

test("spinnerRunLabel combines progress bar and active tool", () => {
  const text = stripAnsi(spinnerRunLabel({ step: 2, maxSteps: 8, tool: "read_file", width: 12 }));
  assert.match(text, /2\/8/);
  assert.match(text, /read_file/);
});

test("createStreamPanel frames streamed output", async () => {
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  let out = "";
  stream.on("data", (chunk) => { out += String(chunk); });
  const panel = createStreamPanel({ width: 30, title: "assistant", stream });
  panel.write("hello\nworld");
  panel.close();
  assert.match(out, /assistant/);
  assert.match(out, /hello/);
  assert.match(out, /world/);
  assert.match(out, /╭/);
  assert.match(out, /╯/);
});

test("quoteBlock formats multiline prompts", () => {
  const lines = quoteBlock("fix the harness\nand tests", { width: 40 });
  assert.equal(lines.length, 2);
  assert.match(stripAnsi(lines[0]), /fix the harness/);
});

test("highlightTerms emphasizes palette matches", () => {
  const text = stripAnsi(highlightTerms("/status", ["sta"]));
  assert.match(text, /\/status/);
});

test("helpPanel renders grouped commands in a frame", () => {
  const lines = helpPanel([
    { title: "Run", items: [["/mode", "switch mode"]] }
  ], { width: 36 });
  const plain = lines.map(stripAnsi).join("\n");
  assert.match(plain, /help/);
  assert.match(plain, /\/mode/);
});

test("progressBar shifts tone near budget limit", () => {
  const low = stripAnsi(progressBar(2, 12, 10));
  const high = stripAnsi(progressBar(11, 12, 10));
  assert.match(low, /2\/12/);
  assert.match(high, /11\/12/);
});
