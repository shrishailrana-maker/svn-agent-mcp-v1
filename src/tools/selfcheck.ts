import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvelope } from "../envelope.js";
import { startupProbe } from "../runner.js";
import type { ToolEnvelope } from "../types.js";

export async function svnSelfCheck(input: { cwd?: string }, runningServerVersion?: string): Promise<ToolEnvelope> {
  const root = await projectRoot();
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    version: string;
    scripts?: Record<string, string>;
  };
  const layout = await inspectRuntimeLayout(root, packageJson.version);
  const probe = await startupProbe(input.cwd ?? root);
  const serverVersion = runningServerVersion ?? packageJson.version;
  const versionMatches = serverVersion === packageJson.version;

  const releasePrepare = packageJson.scripts?.["release:prepare"] ?? "";
  const releasePrepareAvailable = releasePrepare.includes("scripts/prepare-release.mjs")
    && await fileExists(path.join(root, "scripts", "prepare-release.mjs"));
  const clean = packageJson.scripts?.clean ?? "";
  const toolchainOk = probe.svn.ok && probe.svnversion.ok && probe.svnadmin.ok && probe.dos2unix.ok && probe.unix2dos.ok;
  let layoutNote = "";
  if (!layout.layoutOk) {
    layoutNote = layout.currentMatchesPackage
      ? "release payload is incomplete"
      : "current release pointer does not match package version";
  }
  const notes = [
    layoutNote,
    versionMatches ? "" : "running server version does not match package version",
    toolchainOk ? "" : "SVN/EOL toolchain probe failed"
  ].filter(Boolean);

  return {
    ...createEnvelope({
      ok: layout.layoutOk && toolchainOk && versionMatches,
      command: "svn_self_check",
      cwd: root,
      note: notes.join("; ")
    }),
    server_version: serverVersion,
    package_version: packageJson.version,
    runtime_layout: layout.runtimeLayout,
    runtime_root: layout.runtimeRoot,
    runtime_layout_ok: layout.layoutOk,
    current_path: layout.currentPath,
    current_target: layout.currentTarget,
    current_release: layout.currentRelease,
    current_matches_package: layout.currentMatchesPackage,
    release_root: layout.releaseRoot,
    bin_file_count: layout.binFileCount,
    dist_file_count: layout.distFileCount,
    release_prepare_available: releasePrepareAvailable,
    clean_uses_node: clean.startsWith("node "),
    toolchain_ok: toolchainOk,
    startup_probe: probe
  };
}

export async function inspectRuntimeLayout(root: string, version: string, platform: NodeJS.Platform = process.platform) {
  const currentPath = path.join(root, "current");
  const currentTarget = await readLinkTarget(currentPath);
  const currentRelease = currentTarget ? path.basename(currentTarget) : null;
  const releaseRoot = path.join(root, "releases", `v${version}`);
  const currentMatchesPackage = currentRelease === `v${version}`;
  const releaseBinFileCount = await countFiles(path.join(releaseRoot, "bin"));
  const releaseDistFileCount = await countFiles(path.join(releaseRoot, "dist"));
  const common = { currentPath, currentTarget, currentRelease, currentMatchesPackage, releaseRoot };

  if (currentMatchesPackage && await runtimePayloadComplete(releaseRoot, releaseBinFileCount, releaseDistFileCount, platform)) {
    return {
      ...common,
      runtimeLayout: "prepared-release",
      runtimeRoot: releaseRoot,
      layoutOk: true,
      binFileCount: releaseBinFileCount,
      distFileCount: releaseDistFileCount
    };
  }

  const directBinFileCount = await countFiles(path.join(root, "bin"));
  const directDistFileCount = await countFiles(path.join(root, "dist"));
  if (isNodeModulesPackage(root) && await runtimePayloadComplete(root, directBinFileCount, directDistFileCount, platform)) {
    return {
      ...common,
      runtimeLayout: "npm-package",
      runtimeRoot: root,
      layoutOk: true,
      binFileCount: directBinFileCount,
      distFileCount: directDistFileCount
    };
  }

  return {
    ...common,
    runtimeLayout: "source-tree",
    runtimeRoot: releaseRoot,
    layoutOk: false,
    binFileCount: releaseBinFileCount,
    distFileCount: releaseDistFileCount
  };
}

async function runtimePayloadComplete(
  runtimeRoot: string,
  binFileCount: number,
  distFileCount: number,
  platform: NodeJS.Platform
): Promise<boolean> {
  if (distFileCount < 60 || !await fileExists(path.join(runtimeRoot, "dist", "index.js"))) {
    return false;
  }
  if (platform !== "win32") {
    return true;
  }
  const requiredExecutables = ["svn.exe", "svnadmin.exe", "svnversion.exe", "dos2unix.exe", "unix2dos.exe"];
  return binFileCount >= 35 && (await Promise.all(
    requiredExecutables.map((name) => fileExists(path.join(runtimeRoot, "bin", name)))
  )).every(Boolean);
}

async function projectRoot(): Promise<string> {
  let current = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

  while (true) {
    const candidate = path.join(current, "package.json");
    try {
      await fs.access(candidate);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("could not locate package.json");
      }
      current = parent;
    }
  }
}

async function readLinkTarget(value: string): Promise<string | null> {
  try {
    const target = await fs.readlink(value);
    return path.resolve(path.dirname(value), target);
  } catch {
    return null;
  }
}

function isNodeModulesPackage(root: string): boolean {
  return path.resolve(root).split(path.sep).some((segment) => segment.toLowerCase() === "node_modules");
}

async function countFiles(directory: string): Promise<number> {
  try {
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
  } catch {
    return 0;
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}
