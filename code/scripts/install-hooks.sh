#!/bin/bash
# install-hooks.sh — one-time setup per fresh clone.
# Installs the push safety hook and the submodule safety net.
set -e
TOP="$(git rev-parse --show-toplevel)"
cp "$TOP/code/scripts/hooks/pre-push" "$TOP/.git/hooks/pre-push"
chmod +x "$TOP/.git/hooks/pre-push"
git config push.recurseSubmodules on-demand
git submodule update --init
echo "Safety hooks installed."
