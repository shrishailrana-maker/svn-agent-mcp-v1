import type { ChangedPath, Conflict } from "../types.js";

export function parseUpdateText(text: string): { changed_paths: ChangedPath[]; conflicts: Conflict[] } {
  const changed_paths: ChangedPath[] = [];
  const conflicts: Conflict[] = [];

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    const summaryMatch = /^\s*Tree conflicts:\s*(\d+)/i.exec(line);
    if (summaryMatch) {
      continue;
    }

    const columns = line.slice(0, 5).padEnd(5, " ");
    const path = line.slice(5).trim();
    if (!isUpdateStatusColumns(columns)) {
      continue;
    }
    const contentStatus = columns[0] ?? " ";
    const propStatus = columns[1] ?? " ";
    const lockStatus = columns[2] ?? " ";
    const treeStatus = columns[3] ?? " ";
    const status = firstStatus([contentStatus, propStatus, lockStatus, treeStatus]);
    if (!status || !path) {
      continue;
    }

    changed_paths.push({ status, path });
    if (contentStatus === "C") {
      conflicts.push({ path, type: "text" });
    }
    if (propStatus === "C") {
      conflicts.push({ path, type: "prop" });
    }
    if (treeStatus === "C") {
      conflicts.push({ path, type: "tree" });
    }
  }

  return { changed_paths, conflicts };
}

// Real update-status lines use four status columns plus a separator space
// before the path. Informational lines ("Updated to revision 42.",
// "Updating '.':", "At revision 42.") fail this shape and must not become
// phantom changed paths.
function isUpdateStatusColumns(columns: string): boolean {
  if ((columns[4] ?? " ") !== " ") {
    return false;
  }
  for (let index = 0; index < 4; index += 1) {
    if (!/^[UGCEADMRB~! ]$/.test(columns[index] ?? " ")) {
      return false;
    }
  }
  return true;
}

function firstStatus(columns: string[]): string | null {
  for (const status of columns) {
    if (/^[UGCEADMRB~!]$/.test(status)) {
      return status;
    }
  }
  return null;
}
