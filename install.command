#!/usr/bin/env bash
# macOS double-click entry — runs install.sh in the same folder.
cd "$(dirname "$0")"
exec ./install.sh
