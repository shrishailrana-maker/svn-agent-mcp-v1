import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runDos2Unix } from "./runner.js";
import type { EolCheckResult, EolKind, EolSniff, RunResult } from "./types.js";

const SNIFF_LIMIT_BYTES = 5 * 1024 * 1024;
const BINARY_SCAN_BYTES = 8 * 1024;

export interface EolNormalizationResult {
  path: string;
  before?: EolKind;
  after?: EolKind;
  converted?: boolean;
  verified?: boolean;
  skipped?: "binary" | "policy-excluded";
  normalized_content_hash?: string;
  failure?: string;
}

export interface PreparedEolNormalization {
  ok: boolean;
  results: EolNormalizationResult[];
  note?: string;
  rollback(): void;
  dispose(): void;
}

export async function sniffEol(filePath: string, limitBytes = SNIFF_LIMIT_BYTES): Promise<EolSniff> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    return {
      path: filePath,
      kind: "not-a-file",
      has_bom: false,
      size: stat.size,
      sniff: "not-a-file"
    };
  }
  if (stat.size > limitBytes) {
    return {
      path: filePath,
      kind: "skipped-too-large",
      has_bom: false,
      size: stat.size,
      sniff: "skipped-too-large"
    };
  }

  const bytes = await fs.promises.readFile(filePath);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bytes.subarray(0, Math.min(bytes.length, BINARY_SCAN_BYTES)).includes(0)) {
    return {
      path: filePath,
      kind: "binary",
      has_bom: hasBom,
      size: stat.size,
      sniff: "ok"
    };
  }

  return {
    path: filePath,
    kind: classifyEol(bytes),
    has_bom: hasBom,
    size: stat.size,
    sniff: "ok"
  };
}

export async function makeEolCheck(filePath: string, eolStyle: string | null): Promise<EolCheckResult> {
  const sniff = await sniffEol(filePath);
  const isText = sniff.kind !== "binary" && sniff.kind !== "skipped-too-large" && sniff.kind !== "not-a-file";
  const expected = expectedEolKind(eolStyle);
  return {
    ...sniff,
    eol_style: eolStyle,
    mismatch: isText && expected !== null && sniff.kind !== expected && sniff.kind !== "none"
  };
}

export async function convertEol(input: {
  filePath: string;
  target: "crlf" | "lf";
  removeBom: boolean;
  cwd: string;
}): Promise<RunResult> {
  const executable = converterForEolTarget(input.target);
  const args = input.removeBom ? ["--remove-bom", "-q", input.filePath] : ["-q", input.filePath];
  return runDos2Unix(executable, args, input.cwd);
}

export async function prepareEolNormalization(input: {
  files: string[];
  target: "crlf" | "lf";
  cwd: string;
  excluded: (filePath: string) => boolean;
}): Promise<PreparedEolNormalization> {
  const results: EolNormalizationResult[] = [];
  const candidates: Array<{ filePath: string; before: EolSniff; normalizedHash: string }> = [];

  for (const filePath of input.files) {
    if (input.excluded(filePath)) {
      results.push({ path: filePath, skipped: "policy-excluded" });
      continue;
    }
    const before = await sniffEol(filePath);
    if (before.kind === "binary") {
      results.push({ path: filePath, before: before.kind, skipped: "binary" });
      continue;
    }
    if (before.kind === "skipped-too-large" || before.kind === "not-a-file") {
      results.push({ path: filePath, before: before.kind, verified: false, failure: `cannot verify ${before.kind}` });
      return failedPreparation(results, `EOL normalization preflight failed: ${filePath}`);
    }
    candidates.push({ filePath, before, normalizedHash: normalizedContentHash(fs.readFileSync(filePath)) });
  }

  const backupDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "svn-agent-eol-add-"));
  const backups = new Map<string, string>();
  let settled = false;
  const rollback = () => {
    if (settled) {
      return;
    }
    for (const [filePath, backup] of backups) {
      fs.copyFileSync(backup, filePath);
    }
    settled = true;
  };
  const dispose = () => {
    settled = true;
    fs.rmSync(backupDir, { recursive: true, force: true });
  };

  try {
    for (const [index, candidate] of candidates.entries()) {
      const backup = path.join(backupDir, `${index}.bin`);
      fs.copyFileSync(candidate.filePath, backup);
      backups.set(candidate.filePath, backup);
      const needsConversion = candidate.before.has_bom
        || (candidate.before.kind !== "none" && candidate.before.kind !== input.target);
      if (needsConversion) {
        const conversion = await convertEol({
          filePath: candidate.filePath,
          target: input.target,
          removeBom: true,
          cwd: input.cwd
        });
        if (conversion.exitCode !== 0) {
          results.push({
            path: candidate.filePath,
            before: candidate.before.kind,
            converted: false,
            verified: false,
            failure: conversion.stderr || conversion.stdout || "EOL converter failed"
          });
          rollback();
          return { ok: false, results, note: `EOL normalization failed: ${candidate.filePath}`, rollback, dispose };
        }
      }

      const after = await sniffEol(candidate.filePath);
      const afterHash = normalizedContentHash(fs.readFileSync(candidate.filePath));
      const verified = (after.kind === input.target || after.kind === "none")
        && !after.has_bom
        && afterHash === candidate.normalizedHash;
      results.push({
        path: candidate.filePath,
        before: candidate.before.kind,
        after: after.kind,
        converted: needsConversion,
        verified,
        normalized_content_hash: afterHash,
        ...(!verified ? { failure: "normalized content or EOL verification failed" } : {})
      });
      if (!verified) {
        rollback();
        return { ok: false, results, note: `EOL verification failed: ${candidate.filePath}`, rollback, dispose };
      }
    }
    return { ok: true, results, rollback, dispose };
  } catch (error) {
    rollback();
    return {
      ok: false,
      results,
      note: error instanceof Error ? `EOL normalization failed: ${error.message}` : "EOL normalization failed",
      rollback,
      dispose
    };
  }
}

function failedPreparation(results: EolNormalizationResult[], note: string): PreparedEolNormalization {
  return { ok: false, results, note, rollback: () => undefined, dispose: () => undefined };
}

export function normalizedContentHash(bytes: Buffer): string {
  const withoutBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  const canonical = Buffer.from(withoutBom.toString("latin1").replace(/\r\n?/g, "\n"), "latin1");
  return createHash("sha256").update(canonical).digest("hex");
}

export function normalizeEolTarget(value: "crlf" | "lf" | undefined, eolStyle?: string | null): "crlf" | "lf" {
  return value ?? expectedEolKind(eolStyle) ?? platformNativeEolTarget();
}

export function converterForEolTarget(target: "crlf" | "lf"): "unix2dos" | "dos2unix" {
  return target === "crlf" ? "unix2dos" : "dos2unix";
}

export function expectedEolKind(eolStyle?: string | null): "crlf" | "lf" | null {
  const normalized = eolStyle?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "native") {
    return platformNativeEolTarget();
  }
  if (normalized === "lf") {
    return "lf";
  }
  if (normalized === "crlf") {
    return "crlf";
  }
  return null;
}

function platformNativeEolTarget(): "crlf" | "lf" {
  return process.platform === "win32" ? "crlf" : "lf";
}

export function isBinaryKind(kind: EolKind): boolean {
  return kind === "binary";
}

export function displayPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  return relative || ".";
}

function classifyEol(bytes: Buffer): EolKind {
  let crlf = 0;
  let lf = 0;
  let crOnly = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        crOnly += 1;
      }
    } else if (bytes[index] === 0x0a) {
      lf += 1;
    }
  }

  const kinds = [crlf > 0, lf > 0, crOnly > 0].filter(Boolean).length;
  if (kinds === 0) {
    return "none";
  }
  if (kinds > 1 || crOnly > 0) {
    return "mixed";
  }
  return crlf > 0 ? "crlf" : "lf";
}
