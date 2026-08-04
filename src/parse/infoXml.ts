import { XMLParser } from "fast-xml-parser";
import type { SvnLockInfo, WcInfo } from "../types.js";
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
      path?: string;
      revision?: string | number;
      url?: string;
      repository?: { root?: string };
      "wc-info"?: { "wcroot-abspath"?: string };
      lock?: unknown;
    };

    const lock = parseLock(entryObj.lock);

    return {
      path: entryObj.path ?? null,
      url: entryObj.url ?? null,
      repo_root: entryObj.repository?.root ?? null,
      wc_root: entryObj["wc-info"]?.["wcroot-abspath"] ?? null,
      revision: parseRevision(entryObj.revision),
      ...(lock ? { lock } : {})
    };
  });
}

function parseLock(value: unknown): SvnLockInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const lock = value as Record<string, unknown>;
  const read = (name: string): string | null => {
    const candidate = lock[name];
    return typeof candidate === "string" || typeof candidate === "number"
      ? String(candidate)
      : null;
  };
  const parsed: SvnLockInfo = {
    token: read("token"),
    owner: read("owner"),
    comment: read("comment"),
    created: read("created"),
    expires: read("expires")
  };
  return Object.values(parsed).some((item) => item !== null) ? parsed : null;
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
