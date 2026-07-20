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

export function createDiffAccumulator(lineLimit: number, lineOffset = 0): {
  pushLine: (line: string) => void;
  summary: () => DiffSummary;
} {
  const perFile = new Map<string, DiffFileSummary>();
  let current: DiffFileSummary | null = null;
  const excerptLines: string[] = [];
  let totalLines = 0;
  let inPropertyChanges = false;

  return {
    pushLine(line: string): void {
      totalLines += 1;
      if (totalLines > lineOffset && excerptLines.length < lineLimit) {
        excerptLines.push(line);
      }

      const indexMatch = /^Index: (.+)$/.exec(line);
      if (indexMatch) {
        inPropertyChanges = false;
        current = {
          path: indexMatch[1] ?? "",
          added: 0,
          removed: 0,
          binary: false
        };
        perFile.set(current.path, current);
        return;
      }

      const propertyMatch = /^Property changes on: (.+)$/.exec(line);
      if (propertyMatch) {
        const propertyPath = propertyMatch[1] ?? "";
        current = perFile.get(propertyPath) ?? {
          path: propertyPath,
          added: 0,
          removed: 0,
          binary: false
        };
        current.property_changed = true;
        perFile.set(propertyPath, current);
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
        diff_excerpt: excerptLines.join("\n"),
        truncated: totalLines > lineOffset + lineLimit
      };
    }
  };
}
