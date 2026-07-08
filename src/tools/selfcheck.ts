import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvelope } from "../envelope.js";
import { startupProbe } from "../runner.js";
import type { ToolEnvelope } from "../types.js";

export async function svnSelfCheck(input: { cwd?: string }): Promise<ToolEnvelope> {
  const root = await projectRoot();
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    version: string;
    scripts?: Record<string, string>;
  };
  const currentPath = path.join(root, "current");
  const currentTarget = await readLinkTarget(currentPath);
  const currentRelease = currentTarget ? path.basename(currentTarget) : null;
  const releaseRoot = path.join(root, "releases", `v${packageJson.version}`);
  const probe = await startupProbe(input.cwd ?? root);

  const binFileCount = await countFiles(path.join(releaseRoot, "bin"));
  const distFileCount = await countFiles(path.join(releaseRoot, "dist"));
  const releasePrepare = packageJson.scripts?.["release:prepare"] ?? "";
  const clean = packageJson.scripts?.clean ?? "";
  const currentMatchesPackage = currentRelease === `v${packageJson.version}`;
  const toolchainOk = probe.svn.ok && probe.dos2unix.ok && probe.unix2dos.ok;
  const notes = [
    currentMatchesPackage ? "" : "current release pointer does not match package version",
    toolchainOk ? "" : "bundled SVN/EOL toolchain probe failed"
  ].filter(Boolean);

  return {
    ...createEnvelope({
      ok: currentMatchesPackage && binFileCount > 0 && distFileCount > 0 && toolchainOk,
      command: "svn_self_check",
      cwd: root,
      note: notes.join("; ")
    }),
    server_version: packageJson.version,
    package_version: packageJson.version,
    current_path: currentPath,
    current_target: currentTarget,
    current_release: currentRelease,
    current_matches_package: currentMatchesPackage,
    release_root: releaseRoot,
    bin_file_count: binFileCount,
    dist_file_count: distFileCount,
    release_prepare_available: releasePrepare.includes("scripts/prepare-release.mjs"),
    clean_uses_node: clean.startsWith("node "),
    toolchain_ok: toolchainOk,
    startup_probe: probe
  };
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
