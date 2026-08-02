import type { DiffFileSummary, DiffSummary } from "../types.js";

export function parseDiffText(text: string, lineLimit: number): DiffSummary {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  const accumulator = createDiffAccumulator(lineLimit);

  for (const line of lines) {
    accumulator.pushLine(line);
  }

  return accumulator.summary();
}

// The excerpt character budget must stay above the runner's per-line byte cap
// so the first excerpt line always fits and cursor pagination always advances.
const DEFAULT_EXCERPT_CHAR_LIMIT = 2_000_000;

export function createDiffAccumulator(lineLimit: number, lineOffset = 0, fileLimit = 20000, excerptCharLimit = DEFAULT_EXCERPT_CHAR_LIMIT): {
  pushLine: (line: string) => void;
  summary: () => DiffSummary;
  detail: () => { text: string; truncated: boolean };
} {
  const perFile = new Map<string, DiffFileSummary>();
  let current: DiffFileSummary | null = null;
  const excerptLines: string[] = [];
  let totalLines = 0;
  let excerptChars = 0;
  let excerptCharsTruncated = false;
  let inPropertyChanges = false;
  let perFileTruncated = false;
  const detailLines: string[] = [];
  let detailChars = 0;
  let detailTruncated = false;
  let totalChars = 0;
  let totalHunks = 0;
  let totalFiles = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  let binaryFiles = 0;
  let propertyFiles = 0;
  let currentPath = "";
  let currentBinary = false;
  let currentProperty = false;

  function getOrCreateFile(filePath: string): DiffFileSummary | null {
    const existing = perFile.get(filePath);
    if (existing) {
      return existing;
    }
    if (perFile.size >= fileLimit) {
      perFileTruncated = true;
      return null;
    }

    const created = { path: filePath, added: 0, removed: 0, binary: false, hunks: 0 };
    perFile.set(filePath, created);
    return created;
  }

  function startFile(filePath: string): void {
    if (filePath === currentPath) {
      return;
    }
    currentPath = filePath;
    currentBinary = false;
    currentProperty = false;
    totalFiles += 1;
    current = getOrCreateFile(filePath);
  }

  return {
    pushLine(line: string): void {
      totalLines += 1;
      totalChars += line.length + 1;
      if (!detailTruncated) {
        if (detailChars + line.length <= DEFAULT_EXCERPT_CHAR_LIMIT) {
          detailLines.push(line);
          detailChars += line.length + 1;
        } else {
          detailTruncated = true;
        }
      }
      if (totalLines > lineOffset && excerptLines.length < lineLimit && !excerptCharsTruncated) {
        if (excerptChars + line.length <= excerptCharLimit) {
          excerptLines.push(line);
          excerptChars += line.length + 1;
        } else {
          excerptCharsTruncated = true;
        }
      }

      const indexMatch = /^Index: (.+)$/.exec(line);
      if (indexMatch) {
        inPropertyChanges = false;
        startFile(indexMatch[1] ?? "");
        return;
      }

      const propertyMatch = /^Property changes on: (.+)$/.exec(line);
      if (propertyMatch) {
        const propertyPath = propertyMatch[1] ?? "";
        startFile(propertyPath);
        if (!currentProperty) {
          propertyFiles += 1;
          currentProperty = true;
        }
        if (current) {
          current.property_changed = true;
        }
        inPropertyChanges = true;
        return;
      }

      if (!currentPath) {
        return;
      }

      if (line.startsWith("@@")) {
        totalHunks += 1;
        if (current) {
          current.hunks += 1;
          current.first_hunk ??= line;
        }
        return;
      }

      if (/^(?:Cannot display: file marked as a binary type\.|Binary files differ\.)$/i.test(line)) {
        if (!currentBinary) {
          binaryFiles += 1;
          currentBinary = true;
        }
        if (current) {
          current.binary = true;
        }
        return;
      }

      if (!inPropertyChanges && line.startsWith("+") && !line.startsWith("+++")) {
        totalAdded += 1;
        if (current) {
          current.added += 1;
          current.first_meaningful_line ??= line;
        }
      } else if (!inPropertyChanges && line.startsWith("-") && !line.startsWith("---")) {
        totalRemoved += 1;
        if (current) {
          current.removed += 1;
          current.first_meaningful_line ??= line;
        }
      }
    },
    summary(): DiffSummary {
      return {
        per_file: [...perFile.values()],
        per_file_truncated: perFileTruncated,
        diff_excerpt: excerptLines.join("\n"),
        truncated: totalLines > lineOffset + lineLimit || excerptCharsTruncated,
        total_files: totalFiles,
        total_lines: totalLines,
        total_chars: totalChars,
        total_hunks: totalHunks,
        total_added: totalAdded,
        total_removed: totalRemoved,
        binary_files: binaryFiles,
        property_files: propertyFiles
      };
    },
    detail(): { text: string; truncated: boolean } {
      return { text: detailLines.join("\n"), truncated: detailTruncated };
    }
  };
}
