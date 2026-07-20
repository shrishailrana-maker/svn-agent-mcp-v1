import { XMLParser } from "fast-xml-parser";
import type { WcInfo } from "../types.js";
import { svnXmlEntityLimits } from "./xmlOptions.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  processEntities: svnXmlEntityLimits
});

export function parseInfoXml(xml: string): WcInfo[] {
  if (!xml.trim()) {
    return [];
  }

  const parsed = parser.parse(xml) as {
    info?: {
      entry?: unknown;
    };
  };

  return asArray(parsed.info?.entry).map((entry) => {
    const entryObj = entry as {
      revision?: string | number;
      url?: string;
      repository?: { root?: string };
      "wc-info"?: { "wcroot-abspath"?: string };
    };

    return {
      url: entryObj.url ?? null,
      repo_root: entryObj.repository?.root ?? null,
      wc_root: entryObj["wc-info"]?.["wcroot-abspath"] ?? null,
      revision: parseRevision(entryObj.revision)
    };
  });
}

function parseRevision(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
