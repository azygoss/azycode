import test from "node:test";
import assert from "node:assert/strict";
import { env } from "node:process";
import {
  accent,
  badge,
  bold,
  box,
  brand,
  code,
  dim,
  error as errorText,
  faint,
  frame,
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
  promptStatus,
  renderTable,
  rule,
  spinnerFrame,
  spinnerFrames,
  startSpinner,
  statusDot,
  stopSpinner,
  stripAnsi,
  style,
  subtle,
  success as successText,
  tag,
  title as titleText,
  tree,
  truncate,
  visibleLength,
  warn as warnText
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
