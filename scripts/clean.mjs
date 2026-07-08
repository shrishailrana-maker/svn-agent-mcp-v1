#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const targets = ["dist"];

for (const name of targets) {
  const target = path.join(root, name);
  assertInside(root, target);
  if (dryRun) {
    console.log(`Would remove ${target}`);
    continue;
  }
  await fs.rm(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}

function assertInside(base, candidate) {
  const relative = path.relative(base, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to remove outside project root: ${candidate}`);
  }
}
