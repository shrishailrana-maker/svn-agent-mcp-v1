import { createEnvelope, failEnvelope } from "./envelope.js";
import { advancedInputsFor } from "./capabilities.js";
import type { ToolEnvelope } from "./types.js";

const knownTools = new Set([
  "eol", "eol_check", "eol_fix_verified", "svn_add", "svn_blame", "svn_cat", "svn_cleanup",
  "svn_commit", "svn_delete", "svn_diagnose", "svn_diff", "svn_export", "svn_help", "svn_import",
  "svn_info", "svn_lock", "svn_lock_status", "svn_log", "svn_needs_lock", "svn_path_change",
  "svn_precommit", "svn_propget", "svn_propset", "svn_propset_eol_style", "svn_resolve", "svn_revert",
  "svn_self_check", "svn_snapshot", "svn_status", "svn_unlock", "svn_update"
]);

const pathRules = [
  "Relative paths resolve from cwd; cwd must be an absolute working-copy directory.",
  "Use explicit paths. eol_fix_verified accepts regular files only.",
  "Commit directories with expandDescendants:true; a directory-node-only commit needs allowDirectoryTargets:true.",
  "A working-copy-root commit needs allowRoot:true. Prefer scoped paths over a blanket root operation."
];

const responseModes = {
  compact: "Default small structured result; omits raw output, large excerpts, and commit hashes.",
  receipt: "Small audit receipt for mutations; use after commit/update/add and other writes.",
  standard: "Normalized structured detail without full raw output.",
  full: "Largest diagnostic result; use only when compact evidence is insufficient.",
  "structured-only": "Compact structured data with no human text block."
};

const eolContract = {
  normalFlow: [
    "Run svn_precommit normally. autoFixEol defaults to safe; do not call eol_fix_verified first.",
    "Added text with declared svn:eol-style or repository policy is normalized and rechecked automatically.",
    "Modified files are auto-repaired only when ignored-EOL proof shows no real content/property change.",
    "Real content changes are never silently accepted. Follow the returned refusal or nextAction."
  ],
  fixDefaults: {
    target: "Explicit target, else svn:eol-style, else platform native EOL.",
    removeBom: true,
    sizeLimit: "5 MiB unless allowLarge:true.",
    binary: "NUL in the first 8 KiB; never converted. Other C0/DEL controls are advisory only."
  },
  converter: {
    executables: "unix2dos for CRLF and dos2unix for LF; both run with --remove-bom -q by default.",
    resolutionOrder: "SVN_AGENT_DOS2UNIX_DIR, then bundled binary, then PATH.",
    unavailable: "Run svn_self_check. Set SVN_AGENT_DOS2UNIX_DIR to the converter directory or install dos2unix/unix2dos on PATH."
  },
  refusals: {
    mixedEol: "Use default svn_precommit first; for manual repair run eol_fix_verified on the exact files.",
    controlByte: "Inspect the reported byte, line, 1-based byte column, and offset. Non-NUL controls are advisory; NUL means binary and is refused.",
    largeFile: "Review the file, then retry eol_fix_verified with allowLarge:true.",
    realContentChange: "Review the content diff. Use explicit eol_fix_verified only after deciding the rewrite is intended.",
    converterFailed: "Run svn_self_check; repair SVN_AGENT_DOS2UNIX_DIR, bundled runtime, or PATH before retrying the file.",
    truncatedDiff: "Call the copy-ready svn_diff nextAction returned by precommit; continue until no cursor remains."
  },
  examples: [
    { tool: "svn_precommit", args: { cwd: "C:\\work\\project", paths: ["src/new.cs"] } },
    { tool: "eol_fix_verified", args: { cwd: "C:\\work\\project", paths: ["src/new.cs"], target: "crlf" } }
  ]
};

export function svnHelp(input: { tool: string; cwd?: string }): ToolEnvelope {
  const tool = input.tool.trim().toLowerCase();
  const cwd = input.cwd ?? process.cwd();
  if (!knownTools.has(tool)) {
    return {
      ...failEnvelope("svn_help", cwd, `unknown help topic: ${input.tool}`),
      available_topics: [...knownTools].sort()
    };
  }

  return {
    ...createEnvelope({ ok: true, command: "svn_help", cwd, note: `help for ${tool}` }),
    tool,
    path_rules: pathRules,
    response_modes: responseModes,
    contract: {
      ...contractFor(tool),
      ...(advancedInputsFor(tool).length > 0
        ? {
            extendedContract: true,
            advancedInputs: [...advancedInputsFor(tool)],
            advancedInputAvailability: "Advertised by the full profile; focused profiles keep schemas trimmed but svn_help lists them."
          }
        : {})
    }
  };
}

function contractFor(tool: string): Record<string, unknown> {
  if (tool === "svn_add") {
    return {
      ...eolContract,
      add: {
        files: "Explicit files are added directly, then normal svn_precommit performs safe EOL checks.",
        directories: "Set allowRecursive:true. Descendants are scanned for never-commit paths before mutation.",
        order: "svn_add -> svn_precommit (default autoFixEol:safe) -> svn_commit"
      }
    };
  }
  if (tool === "eol" || tool === "eol_check" || tool === "eol_fix_verified") {
    return eolContract;
  }
  if (tool === "svn_precommit") {
    return {
      ...eolContract,
      tokens: {
        baselineToken: "Optional token from svn_snapshot captureBaseline:true; detects path or remote-HEAD changes by another writer.",
        precommitToken: "Returned on READY and bound to exact paths/content/policy/HEAD. TTL is 10 minutes, but bounded-store eviction can remove it sooner.",
        expired: "On EVIDENCE_NOT_FOUND or EVIDENCE_EXPIRED, rerun svn_precommit. svn_commit also runs precommit internally when no reusable token is supplied."
      },
      resultFields: ["verdict", "precommitToken", "remoteHeadRevision", "diffOperationId", "nextAction"]
    };
  }
  if (tool === "svn_commit") {
    return {
      preferred: "Use operation:safe for scoped update, writer collision check, safe EOL repair, precommit, commit, and verification.",
      messageContract: "Subject, blank second line, then one or more '- ' bullets.",
      messageExample: "Update parser\n\n- Verified: 270 tests passed\n- State: requested paths clean",
      precommitToken: "Optional. Default commit creates fresh precommit evidence. Supplied tokens are exact-state bound and process-local; TTL is 10 minutes but bounded-store eviction can remove them sooner. Rerun precommit on EVIDENCE_NOT_FOUND or EVIDENCE_EXPIRED.",
      riskAckTriggers: ["more than 8 paths", "delete-scheduled path", "version file touched", "build-system file touched"],
      separateGuards: [
        "Directory scope uses expandDescendants:true or allowDirectoryTargets:true; it is not inferred from riskAck.",
        "Mixed revisions are normal unless requireUniformRevision:true; stale paths are separate failures.",
        "Property riskAck is separate: svn:ignore/global-ignores, svn:externals, and svn:auto-props."
      ],
      refusalFixes: {
        eol: "Use the returned EOL diagnostic or nextAction.",
        stalePath: "Run svn_update only on the reported path or containing directory when companion additions are reported.",
        expiredToken: "Rerun svn_precommit, then retry commit."
      },
      requiredResultFields: ["revision", "committedPaths", "postStatusClean"]
    };
  }
  if (tool === "svn_update") {
    return {
      guard: "Use explicit paths. No blanket update by default; updateAll:true is the explicit whole-working-copy choice.",
      root: "Prefer paths below the working-copy root. Exact-file updates may omit new companion files and will recommend the containing directory.",
      stalePath: "Update only the reported stale path; use the containing directory only when scopeComplete:false reports omitted additions.",
      multiWriter: "Pass baselineToken from svn_snapshot captureBaseline:true to receive collisionPaths. Conflicts are postponed.",
      filters: {
        maxItems: "Bound the returned change page.",
        cursor: "Continue the previous change page.",
        conflictCursor: "Continue the conflict page.",
        taskPaths: "Declare edited paths for overlap reporting.",
        targetOverlapOnly: "Return only changes overlapping taskPaths."
      }
    };
  }
  if (tool === "svn_snapshot") {
    return {
      captureBaseline: "Set true before editing explicit paths; returns baselineToken for svn_precommit, svn_update, or safe commit.",
      afterCursor: "Snapshot token from the previous result; reports whether state changed without repeating all details.",
      conflictCursor: "Continue a bounded conflict page."
    };
  }
  if (tool === "svn_status") {
    return {
      afterCursor: "Snapshot token from the previous status result; reports change without repeating all details.",
      conflictCursor: "Continue a bounded conflict page."
    };
  }
  if (tool === "svn_propset") {
    return {
      riskAckTriggers: ["svn:ignore or svn:global-ignores", "svn:externals", "svn:auto-props"],
      note: "These property guards are separate from svn_commit riskAck. Other property names do not require riskAck by default."
    };
  }
  if (tool === "svn_diff") {
    return {
      revisionRange: "Use revision:'4801:4850' for an audit range. A single revision is also accepted.",
      paging: "Use operationId and cursor from precommit's copy-ready nextAction to read captured evidence.",
      compact: "Use counts/summary first; request full content only for the exact file or range needed."
    };
  }
  if (tool === "svn_log") {
    return {
      revisionRange: "Use revision:'4801:4850' for an audit range. A single revision is also accepted.",
      paging: "Use the returned cursor until it is absent.",
      filters: {
        changedPathsSummary: "Return bounded top-level changed-path counts.",
        maxTopLevelDirectories: "Limit changed-path summary groups to 1..50.",
        messageContains: "Return revisions whose commit message contains this text.",
        messageCaseSensitive: "Make messageContains matching case-sensitive.",
        scanLimit: "Bound revisions inspected for message filtering to 1..500."
      }
    };
  }
  const advancedInputs = advancedInputsFor(tool);
  return advancedInputs.length > 0
    ? {
        extendedContract: true,
        note: "This tool has advanced inputs; see advancedInputs generated from the runtime capability registry."
      }
    : {
        extendedContract: false,
        note: "No extended tool-specific contract; the advertised schema is complete for this tool.",
        commonRules: "Use the pathRules and responseModes returned with this help result."
      };
}
