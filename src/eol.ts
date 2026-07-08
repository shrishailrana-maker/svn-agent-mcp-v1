import fs from "node:fs";
import path from "node:path";
import { runDos2Unix } from "./runner.js";
import type { EolCheckResult, EolKind, EolSniff, RunResult } from "./types.js";

const SNIFF_LIMIT_BYTES = 5 * 1024 * 1024;
const BINARY_SCAN_BYTES = 8 * 1024;

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
