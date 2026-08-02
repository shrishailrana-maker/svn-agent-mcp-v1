import { SnapshotTokenCodec } from "../src/snapshotToken.js";

describe("snapshot cursor tokens", () => {
  it("detects unchanged and changed state within one process", () => {
    let now = 1_000;
    const codec = new SnapshotTokenCodec(Buffer.alloc(32, 7), 60_000, () => now);
    const token = codec.issue("E:\\dev\\wc", { paths: ["src"] }, { modified: ["src/a.ts"] });

    expect(codec.verify(token, "E:\\dev\\wc", { paths: ["src"] }, { modified: ["src/a.ts"] }))
      .toMatchObject({ ok: true, unchanged: true });
    expect(codec.verify(token, "E:\\dev\\wc", { paths: ["src"] }, { modified: ["src/b.ts"] }))
      .toMatchObject({ ok: true, unchanged: false });

    now += 60_001;
    expect(codec.verify(token, "E:\\dev\\wc", { paths: ["src"] }, { modified: ["src/a.ts"] }))
      .toEqual({ ok: false, code: "SNAPSHOT_CURSOR_EXPIRED", note: "snapshot cursor expired" });
  });

  it("rejects tampering, process restart, option mismatch, and working-copy mismatch", () => {
    const codec = new SnapshotTokenCodec(Buffer.alloc(32, 1));
    const token = codec.issue("E:\\dev\\wc", { includeIgnored: false }, { paths: [] });

    expect(codec.verify(`${token}x`, "E:\\dev\\wc", { includeIgnored: false }, { paths: [] }))
      .toMatchObject({ ok: false, code: "SNAPSHOT_CURSOR_INVALID" });
    expect(new SnapshotTokenCodec(Buffer.alloc(32, 2)).verify(
      token, "E:\\dev\\wc", { includeIgnored: false }, { paths: [] }
    )).toMatchObject({ ok: false, code: "SNAPSHOT_CURSOR_INVALID" });
    expect(codec.verify(token, "E:\\dev\\other", { includeIgnored: false }, { paths: [] }))
      .toMatchObject({ ok: false, code: "SNAPSHOT_CURSOR_WORKING_COPY_MISMATCH" });
    expect(codec.verify(token, "E:\\dev\\wc", { includeIgnored: true }, { paths: [] }))
      .toMatchObject({ ok: false, code: "SNAPSHOT_CURSOR_OPTION_MISMATCH" });
  });
});
