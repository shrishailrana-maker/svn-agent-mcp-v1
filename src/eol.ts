import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { sha256File } from "./fileHash.js";
import { currentRequestCancellationSignal, runDos2Unix } from "./runner.js";
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
  rollback(): { restored: number; skipped: number };
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

  const scan = await scanEolFile(filePath);
  if (scan.binary) {
    return {
      path: filePath,
      kind: "binary",
      has_bom: scan.hasBom,
      size: stat.size,
      sniff: "ok"
    };
  }

  return {
    path: filePath,
    kind: classifyEolCounts(scan.crlf, scan.lf, scan.crOnly),
    has_bom: scan.hasBom,
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
  const normalizedStates = new Map<string, string>();
  let settled = false;
  const rollback = () => {
    if (settled) {
      return { restored: 0, skipped: 0 };
    }
    let restored = 0;
    let skipped = 0;
    for (const [filePath, backup] of backups) {
      const expected = normalizedStates.get(filePath);
      if (!expected || rawContentHashSync(filePath) !== expected) {
        skipped += 1;
        const result = results.find((item) => item.path === filePath);
        if (result) {
          result.verified = false;
          result.failure = [result.failure, "rollback skipped because the file changed after normalization"]
            .filter(Boolean).join("; ");
        }
        continue;
      }
      fs.copyFileSync(backup, filePath);
      restored += 1;
    }
    settled = true;
    return { restored, skipped };
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
          const normalizedState = rawContentHashSync(candidate.filePath);
          if (normalizedState) normalizedStates.set(candidate.filePath, normalizedState);
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
      const normalizedState = rawContentHashSync(candidate.filePath);
      if (normalizedState) normalizedStates.set(candidate.filePath, normalizedState);
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
  return { ok: false, results, note, rollback: () => ({ restored: 0, skipped: 0 }), dispose: () => undefined };
}

export async function normalizedContentHashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath, {
    highWaterMark: 1024 * 1024,
    ...(currentRequestCancellationSignal() ? { signal: currentRequestCancellationSignal() } : {})
  });
  const prefix: number[] = [];
  let prefixHandled = false;
  let pendingCr = false;
  const feed = (bytes: Uint8Array) => {
    const output: number[] = [];
    for (const byte of bytes) {
      if (pendingCr) {
        output.push(0x0a);
        pendingCr = false;
        if (byte === 0x0a) continue;
      }
      if (byte === 0x0d) pendingCr = true;
      else output.push(byte);
    }
    if (output.length > 0) hash.update(Buffer.from(output));
  };
  for await (const chunkValue of stream) {
    const chunk = chunkValue as Buffer;
    let offset = 0;
    if (!prefixHandled) {
      while (prefix.length < 3 && offset < chunk.length) {
        prefix.push(chunk[offset] ?? 0);
        offset += 1;
      }
      if (prefix.length === 3) {
        const contentPrefix = prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf
          ? []
          : prefix;
        feed(Uint8Array.from(contentPrefix));
        prefixHandled = true;
      }
    }
    if (prefixHandled && offset < chunk.length) feed(chunk.subarray(offset));
  }
  if (!prefixHandled) feed(Uint8Array.from(prefix));
  if (pendingCr) hash.update(Buffer.from([0x0a]));
  return hash.digest("hex");
}

export async function restoreBackupIfUnchanged(
  filePath: string,
  backup: Buffer | string,
  expectedCurrentHash: string
): Promise<"restored" | "changed" | "failed"> {
  try {
    if (await sha256File(filePath, currentRequestCancellationSignal()) !== expectedCurrentHash) return "changed";
    if (Buffer.isBuffer(backup)) await fs.promises.writeFile(filePath, backup);
    else await fs.promises.copyFile(backup, filePath);
    return "restored";
  } catch {
    return "failed";
  }
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

  return classifyEolCounts(crlf, lf, crOnly);
}

function classifyEolCounts(crlf: number, lf: number, crOnly: number): EolKind {
  const kinds = [crlf > 0, lf > 0, crOnly > 0].filter(Boolean).length;
  if (kinds === 0) {
    return "none";
  }
  if (kinds > 1 || crOnly > 0) {
    return "mixed";
  }
  return crlf > 0 ? "crlf" : "lf";
}

async function scanEolFile(filePath: string): Promise<{
  hasBom: boolean;
  binary: boolean;
  crlf: number;
  lf: number;
  crOnly: number;
}> {
  const stream = fs.createReadStream(filePath, {
    highWaterMark: 1024 * 1024,
    ...(currentRequestCancellationSignal() ? { signal: currentRequestCancellationSignal() } : {})
  });
  const prefix: number[] = [];
  let scanned = 0;
  let binary = false;
  let crlf = 0;
  let lf = 0;
  let crOnly = 0;
  let pendingCr = false;
  for await (const chunkValue of stream) {
    const chunk = chunkValue as Buffer;
    for (const byte of chunk) {
      if (prefix.length < 3) prefix.push(byte);
      if (scanned < BINARY_SCAN_BYTES && byte === 0) binary = true;
      scanned += 1;
      if (pendingCr) {
        pendingCr = false;
        if (byte === 0x0a) {
          crlf += 1;
          continue;
        }
        crOnly += 1;
      }
      if (byte === 0x0d) pendingCr = true;
      else if (byte === 0x0a) lf += 1;
    }
  }
  if (pendingCr) crOnly += 1;
  return {
    hasBom: prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf,
    binary,
    crlf,
    lf,
    crOnly
  };
}

function rawContentHashSync(filePath: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}
