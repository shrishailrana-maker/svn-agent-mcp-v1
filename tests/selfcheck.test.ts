import { describe, expect, it } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRuntimeLayout, svnSelfCheck } from "../src/tools/selfcheck.js";

describe("svn self-check", () => {
  it("reports package version, current release pointer, and bundled payload counts", async () => {
    const check = await svnSelfCheck({});

    expect(check.ok).toBe(true);
    expect(check.server_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(check.package_version).toBe(check.server_version);
    expect(check.current_release).toBe(`v${check.server_version}`);
    expect(check.current_matches_package).toBe(true);
    expect(check.bin_file_count).toBe(48);
    expect(check.dist_file_count).toBeGreaterThanOrEqual(60);
    expect(check.release_prepare_available).toBe(true);
    expect(check.clean_uses_node).toBe(true);
    expect(check.toolchain_ok).toBe(true);
    expect(check.startup_probe.svn.ok).toBe(true);
    expect(check.startup_probe.svnversion.ok).toBe(true);
    expect(check.startup_probe.svnadmin.ok).toBe(true);
    expect(check.startup_probe.dos2unix.ok).toBe(true);
    expect(check.startup_probe.unix2dos.ok).toBe(true);
  });

  it("fails when the running server version does not match the package", async () => {
    const check = await svnSelfCheck({}, "0.0.0");

    expect(check.ok).toBe(false);
    expect(check.server_version).toBe("0.0.0");
    expect(check.package_version).not.toBe(check.server_version);
    expect(check.note).toContain("running server version does not match package version");
  });

  it("accepts a complete direct npm package layout without a current junction", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "svn-selfcheck-"));
    const packageRoot = path.join(temporaryRoot, "node_modules", "svn-agent-mcp");
    try {
      await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await writeRuntimeFiles(packageRoot, "win32");

      const layout = await inspectRuntimeLayout(packageRoot, "1.1.1");

      expect(layout).toEqual({
        runtimeLayout: "npm-package",
        runtimeRoot: packageRoot,
        layoutOk: true,
        currentPath: path.join(packageRoot, "current"),
        currentTarget: null,
        currentRelease: null,
        currentMatchesPackage: false,
        releaseRoot: path.join(packageRoot, "releases", "v1.1.1"),
        binFileCount: 35,
        distFileCount: 60
      });
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an npm package missing required runtime entrypoints", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "svn-selfcheck-incomplete-"));
    const packageRoot = path.join(temporaryRoot, "node_modules", "svn-agent-mcp");
    try {
      await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "bin", "svn.exe"), "runtime");
      await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "runtime");

      const layout = await inspectRuntimeLayout(packageRoot, "1.1.1");

      expect(layout.runtimeLayout).toBe("source-tree");
      expect(layout.layoutOk).toBe(false);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("accepts a Unix npm package layout without a Windows bin payload", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "svn-selfcheck-unix-"));
    const packageRoot = path.join(temporaryRoot, "node_modules", "svn-agent-mcp");
    try {
      await writeRuntimeFiles(packageRoot, "linux");

      const layout = await inspectRuntimeLayout(packageRoot, "1.1.1", "linux");

      expect(layout.runtimeLayout).toBe("npm-package");
      expect(layout.layoutOk).toBe(true);
      expect(layout.binFileCount).toBe(0);
      expect(layout.distFileCount).toBe(60);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("does not mistake an unprepared source build for an npm package", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "svn-selfcheck-source-"));
    try {
      await fs.mkdir(path.join(packageRoot, "bin"));
      await fs.mkdir(path.join(packageRoot, "dist"));
      await fs.writeFile(path.join(packageRoot, "bin", "svn.exe"), "runtime");
      await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "runtime");

      const layout = await inspectRuntimeLayout(packageRoot, "1.1.1");

      expect(layout.runtimeLayout).toBe("source-tree");
      expect(layout.layoutOk).toBe(false);
      expect(layout.binFileCount).toBe(0);
      expect(layout.distFileCount).toBe(0);
    } finally {
      await fs.rm(packageRoot, { recursive: true, force: true });
    }
  });
});

async function writeRuntimeFiles(root: string, platform: NodeJS.Platform): Promise<void> {
  const dist = path.join(root, "dist");
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, "index.js"), "runtime");
  for (let index = 1; index < 60; index += 1) {
    await fs.writeFile(path.join(dist, `module-${index}.js`), "runtime");
  }
  if (platform !== "win32") {
    return;
  }
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  const executables = ["svn.exe", "svnadmin.exe", "svnversion.exe", "dos2unix.exe", "unix2dos.exe"];
  for (const executable of executables) {
    await fs.writeFile(path.join(bin, executable), "runtime");
  }
  for (let index = executables.length; index < 35; index += 1) {
    await fs.writeFile(path.join(bin, `runtime-${index}.dll`), "runtime");
  }
}
