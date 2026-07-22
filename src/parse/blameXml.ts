import { XMLParser } from "fast-xml-parser";
import { svnXmlEntityLimits } from "./xmlOptions.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  processEntities: svnXmlEntityLimits
});

export interface BlameLine {
  line: number;
  revision: number | null;
  author: string;
  date: string;
}

export function parseBlameXml(xml: string): BlameLine[] {
  if (!xml.trim()) {
    return [];
  }

  const parsed = parser.parse(xml) as { blame?: { target?: { entry?: unknown } } };
  return asArray(parsed.blame?.target?.entry).map((entry) => {
    const item = entry as {
      "line-number"?: string | number;
      commit?: { revision?: string | number; author?: unknown; date?: unknown };
    };
    return {
      line: parseInteger(item["line-number"]),
      revision: item.commit?.revision === undefined ? null : parseInteger(item.commit.revision),
      author: text(item.commit?.author),
      date: text(item.commit?.date)
    };
  });
}

function parseInteger(value: string | number | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
