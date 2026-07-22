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
} {
  const perFile = new Map<string, DiffFileSummary>();
  let current: DiffFileSummary | null = null;
  const excerptLines: string[] = [];
  let totalLines = 0;
  let excerptChars = 0;
  let excerptCharsTruncated = false;
  let inPropertyChanges = false;
  let perFileTruncated = false;

  function getOrCreateFile(filePath: string): DiffFileSummary | null {
    const existing = perFile.get(filePath);
    if (existing) {
      return existing;
    }
    if (perFile.size >= fileLimit) {
      perFileTruncated = true;
      return null;
    }

    const created = { path: filePath, added: 0, removed: 0, binary: false };
    perFile.set(filePath, created);
    return created;
  }

  return {
    pushLine(line: string): void {
      totalLines += 1;
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
        current = getOrCreateFile(indexMatch[1] ?? "");
        return;
      }

      const propertyMatch = /^Property changes on: (.+)$/.exec(line);
      if (propertyMatch) {
        const propertyPath = propertyMatch[1] ?? "";
        current = getOrCreateFile(propertyPath);
        if (current) {
          current.property_changed = true;
        }
        inPropertyChanges = true;
        return;
      }

      if (!current) {
        return;
      }

      if (/^(?:Cannot display: file marked as a binary type\.|Binary files differ\.)$/i.test(line)) {
        current.binary = true;
        return;
      }

      if (!inPropertyChanges && line.startsWith("+") && !line.startsWith("+++")) {
        current.added += 1;
      } else if (!inPropertyChanges && line.startsWith("-") && !line.startsWith("---")) {
        current.removed += 1;
      }
    },
    summary(): DiffSummary {
      return {
        per_file: [...perFile.values()],
        per_file_truncated: perFileTruncated,
        diff_excerpt: excerptLines.join("\n"),
        truncated: totalLines > lineOffset + lineLimit || excerptCharsTruncated
      };
    }
  };
}
