# Built-in Desktop Plugin

This directory contains the source for the three trusted packages that integrate
StarWeave with the official Harness web profile. The Windows seed build copies
these packages into the locked Harness workspace, compiles them against that
Harness commit, and stages ordinary package directories in the installer.

No prebuilt `.tgz` files are stored in this repository or required at runtime.
The installed desktop application publishes the staged directories into its
private data directory and installs them through pnpm's local `file:` protocol.
