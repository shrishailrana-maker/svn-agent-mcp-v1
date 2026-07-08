import { describe, expect, it } from "@jest/globals";
import { svnSelfCheck } from "../src/tools/selfcheck.js";

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
    expect(check.startup_probe.dos2unix.ok).toBe(true);
    expect(check.startup_probe.unix2dos.ok).toBe(true);
  });
});
