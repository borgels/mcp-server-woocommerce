#!/bin/sh
# Prints `ready=true` once the placeholder server has been renamed, else
# `ready=false`. Used by publish.yml and release.yml to publish nothing
# before the rename. The placeholder package name is split so that
# scripts/rename.mjs does not rewrite it.
set -eu
placeholder="mcp-server-exam""ple"
name="$(node -p 'require("./package.json").name')"
if [ -e scripts/rename.mjs ] || [ "$name" = "$placeholder" ]; then
  echo "ready=false"
else
  echo "ready=true"
fi
