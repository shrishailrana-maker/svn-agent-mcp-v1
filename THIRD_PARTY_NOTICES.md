# Third-Party Notices

This project includes a bundled Windows runtime payload in `bin/` so MCP clients can run without
end-user SVN or EOL-converter installation. The project source is licensed under Apache-2.0; the
bundled third-party binaries remain under their upstream licenses.

## VisualSVN Apache Subversion Command-Line Package

- Files: `bin/svn*.exe`, `bin/libsvn*.dll`, `bin/libapr*.dll`, Microsoft runtime support DLLs,
  and related dependencies from the upstream archive
- Bundled SVN version: `1.14.5` (`r1922182`), compiled June 26, 2026
- Distribution build: `Apache-Subversion-1.14.5-4.zip`, published July 6, 2026
- Executable architecture: Windows x86
- Distribution archive SHA256: `1801DC76910BF196948EAF4B4A9A8E0178E39DA6A5339C11413B5E6DCB32E39D`
- Distributor: https://www.visualsvn.com/downloads/
- Upstream: https://subversion.apache.org/
- License: Apache License, Version 2.0, with separately licensed subcomponents

VisualSVN describes this command-line-only package as redistributable. The archive's complete APR,
APR Util, OpenSSL, Subversion, and Zlib license files are reproduced under
`third_party_licenses/apache-subversion-windows/`. The Apache Subversion 1.14.5 `NOTICE` file is
included there as well. The package contains no separate OpenSSL runtime DLLs.

Microsoft Visual C++ runtime support files in `bin/` are copied unmodified from the VisualSVN
archive. Microsoft redistributable runtime license terms apply to those files.

## dos2unix / unix2dos

- Files: `bin/dos2unix.exe`, `bin/unix2dos.exe`, `bin/mac2unix.exe`, and `bin/unix2mac.exe`
- Bundled version: `7.5.6` (May 28, 2026)
- Upstream: https://dos2unix.sourceforge.io/ and https://waterlander.net/dos2unix/
- License: FreeBSD-style license, GPL-compatible

dos2unix is maintained by Erwin Waterlander. Its complete distribution license is reproduced at
`third_party_licenses/dos2unix/COPYING.txt`.

## Binary Checksums

SHA256 checksums for every bundled file are recorded in `THIRD_PARTY_CHECKSUMS.txt`.
