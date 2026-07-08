import { describe, expect, it } from "@jest/globals";
import { parseCommittedRevision } from "../src/parse/commitText.js";
import { parseDiffText } from "../src/parse/diffText.js";
import { parseInfoXml } from "../src/parse/infoXml.js";
import { parseLogXml } from "../src/parse/logXml.js";
import { parseStatusXml } from "../src/parse/statusXml.js";
import { parseUpdateText } from "../src/parse/updateText.js";

describe("SVN text and XML parsers", () => {
  it("counts per-file diff additions and removals without counting headers", () => {
    const diff = parseDiffText(
      [
        "Index: src/example.ts",
        "===================================================================",
        "--- src/example.ts\t(revision 1)",
        "+++ src/example.ts\t(working copy)",
        "@@ -1,2 +1,3 @@",
        " keep",
        "-old",
        "+new",
        "+extra"
      ].join("\n"),
      4
    );

    expect(diff.per_file).toEqual([{ path: "src/example.ts", added: 2, removed: 1, binary: false }]);
    expect(diff.truncated).toBe(true);
  });

  it("parses status XML into changed paths and conflicts", () => {
    const parsed = parseStatusXml(`<?xml version="1.0"?>
<status>
  <target path=".">
    <entry path="src/a.ts"><wc-status item="modified" revision="1" /></entry>
    <entry path="src/b.ts"><wc-status item="conflicted" revision="1" tree-conflicted="true" /></entry>
    <entry path="src/props.txt"><wc-status item="normal" props="modified" /></entry>
    <entry path="src/prop-conflict.txt"><wc-status item="normal" props="conflicted" /></entry>
  </target>
</status>`);

    expect(parsed.changed_paths).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "C", path: "src/b.ts" },
      { status: "_M", path: "src/props.txt" },
      { status: "C", path: "src/prop-conflict.txt" }
    ]);
    expect(parsed.conflicts).toEqual([
      { path: "src/b.ts", type: "text" },
      { path: "src/b.ts", type: "tree" },
      { path: "src/prop-conflict.txt", type: "prop" }
    ]);
  });

  it("parses svn info XML", () => {
    const parsed = parseInfoXml(`<?xml version="1.0"?>
<info>
  <entry kind="dir" path="." revision="7">
    <url>file:///repo/trunk</url>
    <repository><root>file:///repo</root></repository>
    <wc-info><wcroot-abspath>C:\\work\\repo</wcroot-abspath></wc-info>
  </entry>
</info>`);

    expect(parsed[0]).toEqual({
      url: "file:///repo/trunk",
      repo_root: "file:///repo",
      wc_root: "C:\\work\\repo",
      revision: 7
    });
  });

  it("uses null for info XML entries without a working-copy root", () => {
    const parsed = parseInfoXml(`<?xml version="1.0"?>
<info>
  <entry kind="dir" path="." revision="7">
    <url>file:///repo/trunk</url>
    <repository><root>file:///repo</root></repository>
  </entry>
</info>`);

    expect(parsed[0]?.wc_root).toBeNull();
  });

  it("ignores svn update informational lines instead of parsing phantom paths", () => {
    const parsed = parseUpdateText(
      [
        "Updating '.':",
        "U    src/a.ts",
        "Restored 'src/gone.ts'",
        "External at revision 41.",
        "At revision 42.",
        "Updated to revision 42."
      ].join("\n")
    );

    expect(parsed.changed_paths).toEqual([{ status: "U", path: "src/a.ts" }]);
    expect(parsed.conflicts).toEqual([]);
  });

  it("parses log XML and commit/update text", () => {
    expect(parseCommittedRevision("Committed revision 42.")).toBe(42);
    expect(parseUpdateText("U    src/a.ts\nC    src/b.ts\n   C src/tree.ts\nSummary of conflicts:\n  Tree conflicts: 2\n").conflicts).toEqual([
      { path: "src/b.ts", type: "text" },
      { path: "src/tree.ts", type: "tree" },
      { path: "", type: "tree" }
    ]);
    expect(
      parseLogXml(`<log><logentry revision="9"><author>a</author><date>d</date><msg>m</msg><paths><path action="M">/trunk/a</path></paths></logentry></log>`)
    ).toEqual([
      {
        rev: 9,
        author: "a",
        date: "d",
        msg: "m",
        changed_paths: [{ status: "M", path: "/trunk/a" }]
      }
    ]);
  });
});
