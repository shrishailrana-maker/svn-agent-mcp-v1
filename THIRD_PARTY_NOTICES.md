# Third-Party Notices

This project includes a bundled Windows runtime payload in `bin/` so MCP clients can run without
end-user SVN or EOL-converter installation. The project source is licensed under Apache-2.0; the
bundled third-party binaries remain under their upstream licenses.

## SlikSVN / Apache Subversion

- Files: `bin/svn*.exe`, `bin/svnauthz*.exe`, `bin/SlikSvn-*.dll`, `bin/libsvn*.dll`,
  `bin/engines/**`, `bin/System64/**`
- Bundled version observed by `bin/svn.exe --version --quiet`: `1.14.5-SlikSvn`
- Upstream: https://sliksvn.com/ and https://subversion.apache.org/
- License: Apache License, Version 2.0

SlikSVN packages Apache Subversion command-line tools for Windows. Apache Subversion is an Apache
Software Foundation project licensed under Apache-2.0. Keep upstream license and notice obligations
in mind when redistributing the binary payload.

### OpenSSL runtime DLLs included by SlikSVN

- Files: `bin/SlikSvn-libssl-3-x64.dll`, `bin/SlikSvn-libcrypto-3-x64.dll`,
  `bin/engines/capi.dll`
- Observed DLL product version: `3.0.16`
- Upstream: https://openssl-library.org/
- License: Apache License, Version 2.0

### Microsoft Visual C++ runtime support files included by SlikSVN

- Files: `bin/System64/*.dll`
- These files are copied unmodified from the SlikSVN Windows installer payload.
- Microsoft redistributable runtime license terms apply to these files.

## dos2unix / unix2dos

- Files: `bin/dos2unix.exe`, `bin/unix2dos.exe`, `bin/mac2unix.exe`, `bin/unix2mac.exe`,
  as shipped by the upstream Windows 64-bit package
- Bundled version observed by `bin/dos2unix.exe --version`: `7.5.6`
- Upstream: https://dos2unix.sourceforge.io/ and https://waterlander.net/dos2unix/
- License: FreeBSD-style license, GPL-compatible

dos2unix is maintained by Erwin Waterlander. The upstream project publishes its distribution
license as `COPYING.txt`; consult the upstream source distribution for the complete text.

## Binary checksums

SHA256 checksums for the bundled files are recorded in `THIRD_PARTY_CHECKSUMS.txt`.
