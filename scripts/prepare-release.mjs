#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(root, "package.json");
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const version = packageJson.version;

if (!version) {
  throw new Error("package.json version is required");
}

const sourceDist = path.join(root, "dist");
const sourceBin = path.join(root, "bin");
const releasesRoot = path.join(root, "releases");
const releaseRoot = path.join(releasesRoot, `v${version}`);
const releaseDist = path.join(releaseRoot, "dist");
const releaseBin = path.join(releaseRoot, "bin");
const current = path.join(root, "current");

for (const target of [releasesRoot, releaseRoot, releaseDist, releaseBin, current]) {
  assertInside(root, target);
}

await assertDirectory(sourceDist, "dist is missing; run npm run build first");
await assertDirectory(sourceBin, "bin is missing; bundled runtime payload is required");

await fs.rm(releaseRoot, { recursive: true, force: true });
await fs.mkdir(releaseRoot, { recursive: true });
await fs.cp(sourceDist, releaseDist, { recursive: true });
await fs.cp(sourceBin, releaseBin, { recursive: true });

const binFileCount = await countFiles(releaseBin);
const distFileCount = await countFiles(releaseDist);
if (binFileCount < 35) {
  throw new Error(`release bin payload is incomplete: expected at least 35 files, found ${binFileCount}`);
}
if (distFileCount < 60) {
  throw new Error(`release dist payload is incomplete: expected at least 60 files, found ${distFileCount}`);
}

await fs.rm(current, { recursive: true, force: true });
await fs.symlink(path.relative(root, releaseRoot), current, process.platform === "win32" ? "junction" : "dir");

console.log(`Prepared release v${version}`);
console.log(`  dist: ${releaseDist} (${distFileCount} files)`);
console.log(`  bin: ${releaseBin} (${binFileCount} files)`);
console.log(`  current -> ${releaseRoot}`);

async function assertDirectory(candidate, message) {
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) {
      return;
    }
  } catch {
    // handled below
  }
  throw new Error(message);
}

function assertInside(base, candidate) {
  const relative = path.relative(base, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside project root: ${candidate}`);
  }
}

async function countFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(child);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}
