import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandFileReferences } from "../src/prompt-expand.js";

test("expandFileReferences inlines @file attachments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-expand-"));
  fs.writeFileSync(path.join(dir, "note.txt"), "hello from file\n", "utf8");
  const result = expandFileReferences("please review @note.txt", dir);
  assert.match(result.prompt, /hello from file/);
  assert.deepEqual(result.attachments, ["note.txt"]);
});