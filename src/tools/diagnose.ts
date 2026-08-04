import { createEnvelope, failEnvelope, noteFromRun } from "../envelope.js";
import { resolveCwd, resolveTargetsInsideWc } from "../guards.js";
import { escapeSvnTarget, runSvn, startupProbe } from "../runner.js";
import type { RunResult, ToolEnvelope } from "../types.js";
import { getWcContext, svnLockStatus } from "./readonly.js";

type DiagnosticCheck = {
  name: string;
  ok: boolean;
  command: string;
  note: string;
};

export async function svnDiagnose(input: { cwd?: string; paths?: string[] }): Promise<ToolEnvelope> {
  const cwd = resolveCwd(input.cwd);
  const checks: DiagnosticCheck[] = [];
  const suggestions = new Set<string>();
  const probe = await startupProbe(cwd);

  checks.push({
    name: "startup_svn",
    ok: probe.svn.ok,
    command: "startupProbe.svn",
    note: probe.svn.note || probe.svn.version || ""
  });

  if (!probe.svn.ok) {
    suggestions.add("Use the bundled release path or fix the SVN executable before running SVN tools.");
    suggestions.add(
      "Failsafe: for the rest of this session, fall back to scoped raw svn CLI following svnrules (scoped paths, -F message file, ignored-EOL diff, never-commit list); do not use CLI to bypass guard refusals."
    );
    return {
      ...createEnvelope({
        ok: false,
        command: "svn_diagnose",
        cwd,
        note: "svn unavailable"
      }),
      health: "error",
      svn_available: false,
      working_copy_valid: false,
      remote_accessible: false,
      checks,
      suggestions: [...suggestions]
    };
  }

  const context = await getWcContext(input.cwd, input.paths ?? []);
  if (!context.ok) {
    suggestions.add("Run this against an SVN working copy path, or pass an absolute path inside one.");
    return {
      ...failEnvelope("svn_diagnose", cwd, context.envelope.note || "path is not inside a working copy"),
      health: "error",
      svn_available: true,
      working_copy_valid: false,
      remote_accessible: false,
      checks,
      suggestions: [...suggestions]
    };
  }

  const targets = input.paths && input.paths.length > 0 ? input.paths : [context.cwd];
  const resolved = resolveTargetsInsideWc(context.cwd, context.wcRoot, targets);
  if (!resolved.ok) {
    suggestions.add("Keep diagnostic targets inside one SVN working copy.");
    return {
      ...failEnvelope("svn_diagnose", context.cwd, resolved.note),
      health: "error",
      svn_available: true,
      working_copy_valid: true,
      wc_root: context.wcRoot,
      remote_accessible: false,
      checks,
      suggestions: [...suggestions]
    };
  }

  const [localStatus, remoteStatus, remoteInfo, log] = await Promise.all([
    runDiagnostic("local_status", ["status", "--xml", "--", ...resolved.paths.map(escapeSvnTarget)], context.cwd),
    runDiagnostic("remote_status", ["status", "--show-updates", "--xml", "--", ...resolved.paths.map(escapeSvnTarget)], context.cwd),
    runDiagnostic("remote_info_head", ["info", "--xml", "-r", "HEAD", "--", ...resolved.paths.map(escapeSvnTarget)], context.cwd),
    runDiagnostic("log_latest", ["log", "--xml", "-l", "1", "--", escapeSvnTarget(context.cwd)], context.cwd)
  ]);

  for (const result of [localStatus, remoteStatus, remoteInfo, log]) {
    checks.push(result.check);
    addSuggestion(result.run, suggestions);
  }

  const localOk = localStatus.check.ok;
  const remoteAccessible = remoteStatus.check.ok || remoteInfo.check.ok || log.check.ok;
  const health = localOk && remoteAccessible
    ? "healthy"
    : localOk
      ? "warning"
      : "error";

  if (!remoteAccessible) {
    suggestions.add("Local SVN works but remote checks failed; verify network access and cached SVN credentials outside the MCP.");
  }
  if (!localOk) {
    suggestions.add("Local status failed; run svn_cleanup if the working copy is locked or damaged.");
  }

  let lockDiagnostics: Array<Record<string, unknown>> = [];
  if (input.paths && input.paths.length > 0) {
    const lockStatus = await svnLockStatus({ cwd: context.cwd, paths: resolved.paths, maxItems: 500 });
    if (lockStatus.ok) {
      const locks = Array.isArray(lockStatus.locks)
        ? lockStatus.locks.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
        : [];
      lockDiagnostics = locks.filter((row) => ["held-elsewhere", "orphaned-token", "stale-candidate"].includes(String(row.state)));
      checks.push({
        name: "repository_locks",
        ok: true,
        command: lockStatus.command,
        note: lockDiagnostics.length > 0 ? "lock attention required" : ""
      });
      for (const row of lockDiagnostics) {
        const state = String(row.state);
        if (state === "held-elsewhere") {
          suggestions.add(`Repository lock held elsewhere: ${String(row.path ?? "target")}`);
        } else if (state === "orphaned-token") {
          suggestions.add(`Working copy has an orphaned lock token: ${String(row.path ?? "target")}`);
        } else if (state === "stale-candidate") {
          suggestions.add(`Repository lock is older than seven days and is a stale candidate: ${String(row.path ?? "target")}`);
        }
      }
    } else {
      checks.push({
        name: "repository_locks",
        ok: false,
        command: lockStatus.command,
        note: lockStatus.note || "repository lock status unavailable"
      });
    }
  }

  return {
    ...createEnvelope({
      ok: health !== "error",
      command: "svn_diagnose",
      cwd: context.cwd,
      note: health === "healthy" ? "" : health === "warning" ? "remote checks failed" : "local SVN checks failed"
    }),
    health,
    svn_available: true,
    working_copy_valid: true,
    wc_root: context.wcRoot,
    remote_accessible: remoteAccessible,
    checks,
    suggestions: [...suggestions],
    lock_diagnostics: lockDiagnostics
  };
}

async function runDiagnostic(name: string, args: string[], cwd: string): Promise<{ check: DiagnosticCheck; run: RunResult }> {
  const run = await runSvn(args, cwd);
  return {
    run,
    check: {
      name,
      ok: run.exitCode === 0,
      command: run.command,
      note: run.exitCode === 0 ? "" : noteFromRun(run)
    }
  };
}

function addSuggestion(run: RunResult, suggestions: Set<string>): void {
  if (run.exitCode === 0) {
    return;
  }

  const note = noteFromRun(run);
  if (/authentication/i.test(note)) {
    suggestions.add("Fix cached SVN authentication outside the MCP, then retry.");
  } else if (/network|connect/i.test(note)) {
    suggestions.add("Check network access and repository URL reachability.");
  } else if (/cleanup|locked|database/i.test(note)) {
    suggestions.add("Run svn_cleanup on the working copy before retrying.");
  } else if (/working copy|versioned/i.test(note)) {
    suggestions.add("Pass a path inside a valid SVN working copy.");
  }
}
