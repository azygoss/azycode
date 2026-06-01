#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const debug = process.env.AZYCODE_DEBUG === "1" || process.env.AZYCODE_DEBUG === "true";
  const message = debug ? (error?.stack || error?.message || String(error)) : (error?.message || String(error));
  console.error(`azycode: ${message}`);
  process.exitCode = 1;
});
