import { stdout } from "node:process";

const colorsEnabled = Boolean(stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m"
};

export function style(text, name) {
  if (!colorsEnabled || !color[name]) return text;
  return `${color[name]}${text}${color.reset}`;
}

export function title(text) {
  console.log(style(text, "bold"));
}

export function section(text) {
  console.log(`\n${style(text, "cyan")}`);
}

export function kv(key, value) {
  console.log(`${String(key).padEnd(18)} ${value ?? ""}`);
}

export function list(items) {
  for (const item of items) console.log(`  ${item}`);
}

export function table(rows, columns) {
  if (!rows.length) return;
  const widths = columns.map((column) => {
    const cells = rows.map((row) => stripAnsi(String(row[column.key] ?? "")));
    return Math.max(column.label.length, ...cells.map((cell) => cell.length));
  });
  console.log(columns.map((column, index) => {
    const label = index === columns.length - 1 ? column.label : column.label.padEnd(widths[index]);
    return style(label, "dim");
  }).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => {
      const cell = String(row[column.key] ?? "");
      return index === columns.length - 1 ? cell : cell.padEnd(widths[index]);
    }).join("  "));
  }
}

export function badge(value) {
  if (value === true || value === "ok" || value === "enabled") return style(String(value), "green");
  if (value === false || value === "failed" || value === "disabled") return style(String(value), "red");
  return style(String(value), "yellow");
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
