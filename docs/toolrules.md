# Tool And PowerShell Rules

Read only when choosing a command/tool, debugging shell behavior, or doing mechanical edits. Do not
run capability sweeps unless the task is about tool availability.

## Local toolchain

Prefer these tools when available: `rg`, `fd`, `sg`, `jq`, `yq`, `duckdb`, `xsv`, `uv`,
`python`, `node`, `npm`, `npx`, `dotnet`, `git`, `svn`, `bat`, `glow`, `pandoc`, `ffmpeg`,
and `ctags`. Project-specific build commands must come from that project's README,
project instructions, or build scripts.

- `rg` before manual text inspection; `fd` / `rg --files` only to locate a specific named file/pattern (not broad discovery); `sg` for
  syntax-aware search/edits; `jq`/`duckdb`/`xsv` for structured data.
- Read-only review roles may only read/search/extract; scripts must print/extract only, never
  write files or run project code.
- `graphify` is read/navigation only; the graph lives in the parent repo `.graphify/`. Do not rebuild
  it unless the user asks.
- If a tool is missing, say so and use the nearest installed fallback.

## PowerShell

- Prefer simple, targeted commands. Avoid broad recursive `Get-ChildItem` when `rg --files`/`fd` works.
- Do not use `Set-Content`/`Out-File` on tracked text files; use the Edit/Write tool. Keep tracked
  text UTF-8 (no BOM where the file already is) and the file's existing EOL.
- For line slices use `$lines = Get-Content -LiteralPath path; $lines[120..170]`, or
  `Get-Content path | Select-Object -Skip 120 -First 50`. Do not pass `120..170` directly to
  `Select-Object -Index`; PowerShell treats it as a string in some invocation contexts.
- Use single-quoted strings for literal Windows paths. Use `curl.exe`, not `curl`, for real HTTP.
- Multi-line strings to native exes: single-quoted here-strings with the closing `'@` at column 0.
- For SVN EOL repair, use MCP `eol_fix_verified` or the bundled `unix2dos`/`dos2unix` binaries.
  Do not use PowerShell byte rewrites or redirects on tracked text files.
- For SVN property reads/writes, use MCP `svn_propget` and guarded `svn_propset` before falling
  back to raw `svn propget` / `svn propset`.
