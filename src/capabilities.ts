export const advancedInputNames = {
  svn_status: ["afterCursor", "conflictCursor"],
  svn_snapshot: ["afterCursor", "conflictCursor", "captureBaseline"],
  svn_diff: ["file", "operationId"],
  eol_fix_verified: ["operationId"],
  svn_precommit: ["baselineToken", "autoFixEol"],
  svn_log: ["changedPathsSummary", "maxTopLevelDirectories", "messageContains", "messageCaseSensitive", "scanLimit"],
  svn_update: ["maxItems", "cursor", "conflictCursor", "taskPaths", "targetOverlapOnly", "operationId", "baselineToken"],
  svn_commit: [
    "operation", "revision", "expectedRemoteHead", "lineLimit", "requireUniformRevision",
    "expandDescendants", "allowRoot", "allowDirectoryTargets", "operationId", "precommitToken",
    "baselineToken", "detailOperationId", "cursor", "maxChars"
  ],
  svn_resolve: ["operationId"],
  svn_lock: ["operationId"],
  svn_unlock: ["operationId"],
  svn_needs_lock: ["operationId"]
} as const;

export type AdvancedInputTool = keyof typeof advancedInputNames;

export function advancedInputsFor(tool: string): readonly string[] {
  return tool in advancedInputNames
    ? advancedInputNames[tool as AdvancedInputTool]
    : [];
}
