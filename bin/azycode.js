#!/usr/bin/env node
import { main } from "../src/cli.js";

function formatError(error) {
  const debug = process.env.AZYCODE_DEBUG === "1" || process.env.AZYCODE_DEBUG === "true";
  return debug ? (error?.stack || error?.message || String(error)) : (error?.message || String(error));
}

process.on("uncaughtException", (error) => {
  console.error(`azycode: uncaught exception: ${formatError(error)}`);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  console.error(`azycode: unhandled rejection: ${formatError(reason)}`);
  process.exitCode = 1;
});

main(process.argv.slice(2)).catch((error) => {
  console.error(`azycode: ${formatError(error)}`);
  process.exitCode = 1;
});
