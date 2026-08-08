import { XMLParser } from "fast-xml-parser";
import type { ChangedPath, Conflict } from "../types.js";
import { svnXmlEntityLimits } from "./xmlOptions.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  processEntities: svnXmlEntityLimits
});

const statusMap: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  replaced: "R",
  conflicted: "C",
  external: "X",
  ignored: "I",
  unversioned: "?",
  missing: "!",
  incomplete: "!",
  obstructed: "~",
  normal: "",
  none: ""
};

export function parseStatusXml(xml: string): {
  changed_paths: ChangedPath[];
  conflicts: Conflict[];
  out_of_date_paths: string[];
} {
  if (!xml.trim()) {
    return { changed_paths: [], conflicts: [], out_of_date_paths: [] };
  }

  const parsed = parser.parse(xml) as {
    status?: {
      target?: unknown;
    };
  };

  const targets = asArray(parsed.status?.target);
  const changed_paths: ChangedPath[] = [];
  const conflicts: Conflict[] = [];
  const outOfDatePaths = new Set<string>();

  for (const target of targets) {
    const targetObj = target as { entry?: unknown };
    for (const entry of asArray(targetObj.entry)) {
      const entryObj = entry as {
        path?: string;
        "wc-status"?: {
          item?: string;
          props?: string;
          "tree-conflicted"?: string | boolean;
        };
        "repos-status"?: {
          item?: string;
          props?: string;
        };
      };
      const item = entryObj["wc-status"]?.item ?? "";
      const props = entryObj["wc-status"]?.props ?? "";
      let status = statusMap[item] ?? (item ? "UNKNOWN" : "");
      const path = entryObj.path ?? "";

      if (!status && props === "modified") {
        status = "_M";
      }
      if (props === "conflicted") {
        status = status || "C";
      }

      if (status) {
        changed_paths.push({ status, path });
      }

      if (item === "conflicted") {
        conflicts.push({ path, type: "text" });
      }
      if (props === "conflicted") {
        conflicts.push({ path, type: "prop" });
      }

      if (entryObj["wc-status"]?.["tree-conflicted"] === "true" || entryObj["wc-status"]?.["tree-conflicted"] === true) {
        conflicts.push({ path, type: "tree" });
      }

      const repositoryItem = entryObj["repos-status"]?.item ?? "none";
      const repositoryProps = entryObj["repos-status"]?.props ?? "none";
      if (path && (isRepositoryChange(repositoryItem) || isRepositoryChange(repositoryProps))) {
        outOfDatePaths.add(path);
      }
    }
  }

  return { changed_paths, conflicts, out_of_date_paths: [...outOfDatePaths] };
}

function isRepositoryChange(value: string): boolean {
  return value !== "" && value !== "none" && value !== "normal";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
