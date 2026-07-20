import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { messageFormatWarning, neverCommitHit, pathIdentityKey, readonlyMode, resolveTargetsInsideWc, riskySignals } from "../src/guards.js";
import { sniffEol } from "../src/eol.js";

describe("guards and EOL sniffing", () => {
  it("preserves case for POSIX path identities", () => {
    const upper = path.resolve("CaseSensitiveRoot");
    const lower = path.resolve("casesensitiveroot");

    expect(pathIdentityKey(upper, "linux")).not.toBe(pathIdentityKey(lower, "linux"));
    expect(pathIdentityKey(upper, "darwin")).not.toBe(pathIdentityKey(lower, "darwin"));
    expect(pathIdentityKey(upper, "win32")).toBe(pathIdentityKey(lower, "win32"));
  });

  it("detects never-commit paths and risky slices", () => {
    const root = path.resolve("C:/repo");
    expect(neverCommitHit(path.join(root, "bin", "app.dll"), root)).toBe("**/bin/**");
    expect(neverCommitHit(path.join(root, "src", "App", "bin", "Debug", "app.dll"), root)).toBe("**/bin/**");
    expect(neverCommitHit(path.join(root, "src", "App", "obj", "Debug", "app.dll"), root)).toBe("**/obj/**");
    expect(neverCommitHit(path.join(root, "dist", "index.js"), root)).toBe("**/dist/**");
    expect(neverCommitHit(path.join(root, "src", "dist", "bundle.js"), root)).toBe("**/dist/**");
    expect(neverCommitHit(path.join(root, "node_modules", "pkg", "index.js"), root)).toBe("**/node_modules/**");
    expect(neverCommitHit(path.join(root, "coverage", "lcov.info"), root)).toBe("**/coverage/**");
    expect(neverCommitHit(path.join(root, "scratch", "notes.txt"), root)).toBe("scratch/**");
    expect(neverCommitHit(path.join(root, "tsconfig.tsbuildinfo"), root)).toBe("**/*.tsbuildinfo");
    expect(neverCommitHit(path.join(root, "binary.txt"), root)).toBeNull();
    expect(neverCommitHit(path.join(root, "distillery", "notes.txt"), root)).toBeNull();
    expect(neverCommitHit(path.join(root, "src", "app.ts"), root)).toBeNull();

    const paths = Array.from({ length: 9 }, (_, index) => path.join(root, "src", `f${index}.ts`));
    expect(riskySignals(paths, root)).toContain("more than 8 paths");
    expect(riskySignals([path.join(root, "app.csproj")], root)).toContain("build-system file touched");
  });

  it("allows repository-local never-commit exceptions without weakening nested defaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-policy-"));
    try {
      fs.writeFileSync(
        path.join(root, ".svn-mcp-policy.json"),
        JSON.stringify({
          neverCommit: {
            allow: ["bin/**", "releases/v*/bin/**", "releases/v*/dist/**"]
          }
        }),
        "utf8"
      );

      expect(neverCommitHit(path.join(root, "bin", "svn.exe"), root)).toBeNull();
      expect(neverCommitHit(path.join(root, "releases", "v1.2.3", "dist", "index.js"), root)).toBeNull();
      expect(neverCommitHit(path.join(root, "src", "App", "bin", "Debug", "app.dll"), root)).toBe("**/bin/**");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps repository-local deny rules stronger than broad allow exceptions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-policy-deny-"));
    try {
      fs.writeFileSync(
        path.join(root, ".svn-mcp-policy.json"),
        JSON.stringify({
          neverCommit: {
            allow: ["releases/**"],
            deny: ["releases/**/secrets/**"]
          }
        }),
        "utf8"
      );

      expect(neverCommitHit(path.join(root, "releases", "v1.2.3", "dist", "index.js"), root)).toBeNull();
      expect(neverCommitHit(path.join(root, "releases", "v1.2.3", "dist", "secrets", "key.pem"), root)).toBe("releases/**/secrets/**");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let repository-local allow rules permit credential files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-policy-secrets-"));
    try {
      fs.writeFileSync(
        path.join(root, ".svn-mcp-policy.json"),
        JSON.stringify({ neverCommit: { allow: ["**"] } }),
        "utf8"
      );

      expect(neverCommitHit(path.join(root, "config", "signing.key"), root)).toBe("**/*.key");
      expect(neverCommitHit(path.join(root, ".env.production"), root)).toBe("**/.env*");
      expect(neverCommitHit(path.join(root, ".npmrc"), root)).toBe("**/.npmrc");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports invalid and unsafe repository-local policies as policy errors", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-policy-invalid-"));
    try {
      fs.writeFileSync(path.join(root, ".svn-mcp-policy.json"), "{not json", "utf8");
      expect(neverCommitHit(path.join(root, "src", "app.ts"), root)).toBe("policy-error: invalid .svn-mcp-policy.json");

      fs.writeFileSync(
        path.join(root, ".svn-mcp-policy.json"),
        JSON.stringify({ neverCommit: { deny: ["**/**/**/**/**/**/**/**/**/**/*.ts"] } }),
        "utf8"
      );
      expect(neverCommitHit(path.join(root, "src", "app.ts"), root)).toContain("policy-error:");

      fs.writeFileSync(
        path.join(root, ".svn-mcp-policy.json"),
        JSON.stringify({ neverCommit: { deny: ["*a*a*a*a*a*a*a*a*aZ"] } }),
        "utf8"
      );
      expect(neverCommitHit(path.join(root, "src", "app.ts"), root)).toContain("policy-error:");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns on non-template commit messages", () => {
    expect(messageFormatWarning("Short\n\n- verification")).toBeNull();
    expect(messageFormatWarning("Short only")).toBe("commit message format warning");
  });

  it("returns realpath-expanded paths for SVN command targets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-realpath-"));
    try {
      fs.mkdirSync(path.join(root, "nested"));
      const cwd = process.platform === "win32" ? root.toUpperCase() : root;
      const resolved = resolveTargetsInsideWc(cwd, cwd, ["nested/new-file.txt"]);

      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.paths).toEqual([
          path.join(fs.realpathSync.native(root), "nested", "new-file.txt")
        ]);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enables readonly mode from a CLI flag without end-user environment variables", () => {
    const savedArgv = [...process.argv];
    const savedReadonly = process.env.SVN_AGENT_READONLY;
    delete process.env.SVN_AGENT_READONLY;

    try {
      expect(readonlyMode()).toBe(false);
      process.argv.push("--readonly");
      expect(readonlyMode()).toBe(true);
    } finally {
      process.argv.splice(0, process.argv.length, ...savedArgv);
      if (savedReadonly === undefined) {
        delete process.env.SVN_AGENT_READONLY;
      } else {
        process.env.SVN_AGENT_READONLY = savedReadonly;
      }
    }
  });

  it("classifies CRLF, LF, mixed, BOM, and binary files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-eol-"));
    try {
      const crlf = path.join(dir, "crlf.txt");
      const lf = path.join(dir, "lf.txt");
      const mixed = path.join(dir, "mixed.txt");
      const bom = path.join(dir, "bom.txt");
      const binary = path.join(dir, "binary.bin");

      fs.writeFileSync(crlf, "a\r\nb\r\n", "utf8");
      fs.writeFileSync(lf, "a\nb\n", "utf8");
      fs.writeFileSync(mixed, "a\r\nb\n", "utf8");
      fs.writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]));
      fs.writeFileSync(binary, Buffer.from([0x61, 0x00, 0x62]));

      await expect(sniffEol(crlf)).resolves.toMatchObject({ kind: "crlf" });
      await expect(sniffEol(lf)).resolves.toMatchObject({ kind: "lf" });
      await expect(sniffEol(mixed)).resolves.toMatchObject({ kind: "mixed" });
      await expect(sniffEol(bom)).resolves.toMatchObject({ has_bom: true });
      await expect(sniffEol(binary)).resolves.toMatchObject({ kind: "binary" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured not-a-file sniff for directories instead of throwing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-agent-eol-dir-"));
    try {
      await expect(sniffEol(dir)).resolves.toMatchObject({ kind: "not-a-file", sniff: "not-a-file" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
