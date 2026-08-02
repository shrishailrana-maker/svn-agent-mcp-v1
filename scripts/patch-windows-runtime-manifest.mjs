import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "scripts", "windows-utf8-active-code-page.manifest");
const executable = path.join(root, "bin", "svn.exe");
const mtArgument = process.argv.indexOf("--mt");
const mt = mtArgument >= 0 ? process.argv[mtArgument + 1] : process.env.MT_EXE;

if (!mt || !fs.existsSync(mt)) {
  throw new Error("Windows Manifest Tool required; pass --mt <absolute-path-to-mt.exe> or set MT_EXE");
}
if (!fs.existsSync(executable) || !fs.existsSync(manifest)) {
  throw new Error("bundled svn.exe or UTF-8 manifest is missing");
}

execFileSync(mt, ["-manifest", manifest, `-outputresource:${executable};#1`], { stdio: "inherit" });
console.log(`Embedded the UTF-8 active-code-page manifest in ${path.relative(root, executable)}.`);
