#!/usr/bin/env bash
# logo-craft 스킬 설치 → ~/.claude/skills/logo-craft
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ~/.claude/skills
rm -rf ~/.claude/skills/logo-craft
cp -R skill/logo-craft ~/.claude/skills/
echo "✓ 설치 끝: ~/.claude/skills/logo-craft"
