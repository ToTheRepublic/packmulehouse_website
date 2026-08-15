#!/bin/bash
# Render STL(s) with the user-local Blender install.
# Example:
#   scripts/render-stl.sh --input models/kit.stl --out renders/kit --mode still
#   scripts/render-stl.sh --input models/a.stl --input models/b.stl --out renders/turn --mode turntable --frames 36
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/bin:$PATH"
if ! command -v blender >/dev/null 2>&1; then
  echo "blender wrapper not found at ~/bin/blender" >&2
  exit 1
fi
exec blender --background --factory-startup --python "$ROOT/scripts/blender_render_stl.py" -- "$@"
