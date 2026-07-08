import { XMLParser } from "fast-xml-parser";
import type { ChangedPath } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text"
});

export interface LogEntry {
  rev: number;
  author: string;
  date: string;
  msg: string;
  changed_paths: ChangedPath[];
}

export function parseLogXml(xml: string): LogEntry[] {
  if (!xml.trim()) {
    return [];
  }

  const parsed = parser.parse(xml) as {
    log?: {
      logentry?: unknown;
    };
  };

  return asArray(parsed.log?.logentry).map((entry) => {
    const entryObj = entry as {
      revision?: string | number;
      author?: string;
      date?: string;
      msg?: string;
      paths?: { path?: unknown };
    };

    return {
      rev: parseNumber(entryObj.revision),
      author: entryObj.author ?? "",
      date: entryObj.date ?? "",
      msg: entryObj.msg ?? "",
      changed_paths: asArray(entryObj.paths?.path).map((pathEntry) => {
        const pathObj = pathEntry as { action?: string; text?: string };
        return {
          status: pathObj.action ?? "",
          path: pathObj.text ?? ""
        };
      })
    };
  });
}

function parseNumber(value: string | number | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
