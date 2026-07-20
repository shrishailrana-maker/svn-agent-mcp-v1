#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const nodeVersion = process.versions.node;
const npmVersion = npmVersionFromEnvironment();

if (!inSupportedLine(nodeVersion, 24, 18)) {
  throw new Error(`Node.js 24.18.0 or newer within the Node 24 LTS line is required; found ${nodeVersion}`);
}
if (!atLeast(npmVersion, 11, 16, 0)) {
  throw new Error(`npm 11.16.0 or newer is required; found ${npmVersion}`);
}

console.log(`LTS runtime verified: Node.js ${nodeVersion}, npm ${npmVersion}`);

function npmVersionFromEnvironment() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, "--version"], { encoding: "utf8", windowsHide: true }).trim();
  }
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(command, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
}

function inSupportedLine(value, expectedMajor, minimumMinor) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  return Boolean(match && Number(match[1]) === expectedMajor && Number(match[2]) >= minimumMinor);
}

function atLeast(value, minimumMajor, minimumMinor, minimumPatch) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }

  const actual = match.slice(1).map(Number);
  const minimum = [minimumMajor, minimumMinor, minimumPatch];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) {
      return actual[index] > minimum[index];
    }
  }
  return true;
}
