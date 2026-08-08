import { XMLParser } from "fast-xml-parser";
import { svnXmlEntityLimits } from "./xmlOptions.js";

export interface RepositoryListEntry {
  name: string;
  kind: "file" | "dir" | "unknown";
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  parseTagValue: false,
  trimValues: false,
  processEntities: svnXmlEntityLimits
});

export function parseListXml(
  xml: string,
  maxEntries = 5000
): { entries: RepositoryListEntry[]; truncated: boolean } {
  if (!xml.trim()) {
    return { entries: [], truncated: false };
  }

  const parsed = parser.parse(xml) as { lists?: { list?: unknown } };
  const entries: RepositoryListEntry[] = [];
  let totalEntries = 0;

  for (const list of asArray(parsed.lists?.list)) {
    const listObject = list as { entry?: unknown };
    for (const entry of asArray(listObject.entry)) {
      totalEntries += 1;
      if (entries.length >= maxEntries) {
        continue;
      }
      const entryObject = entry as { kind?: string; name?: string | number };
      const name = entryObject.name === undefined ? "" : String(entryObject.name).trim();
      if (!name) {
        continue;
      }
      entries.push({
        name,
        kind: entryObject.kind === "file" || entryObject.kind === "dir" ? entryObject.kind : "unknown"
      });
    }
  }

  return { entries, truncated: totalEntries > entries.length };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
