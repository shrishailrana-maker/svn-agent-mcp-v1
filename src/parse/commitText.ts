export function parseCommittedRevision(text: string): number | null {
  const match = /Committed revision (\d+)\./i.exec(text);
  if (!match) {
    return null;
  }

  const revision = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(revision) ? revision : null;
}
