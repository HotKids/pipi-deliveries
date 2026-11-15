#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s PATH_TO_SYNCED_SCRIPTING_TSCONFIG\n' "$0" >&2
  exit 2
fi

project=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
temp_root=$(python3 "$project/tools/package-files.py" --temp-root)
mkdir -p "$temp_root"
temp_dir=$(mktemp -d "$temp_root/pipi-deliveries-typecheck.XXXXXX")
trap 'rm -f "$temp_dir/tsconfig.json"; rmdir "$temp_dir"' EXIT HUP INT TERM

python3 - "$project" "$1" "$temp_dir/tsconfig.json" <<'PY'
import json
import sys
from pathlib import Path

project, sdk_config, output = [Path(value).resolve() for value in sys.argv[1:]]
declarations = sdk_config.parent / "dts"
for required in (sdk_config, declarations / "global.d.ts", declarations / "scripting.d.ts"):
    if not required.is_file():
        raise SystemExit(f"Missing Scripting workspace file: {required}")
config = {
    "extends": str(sdk_config),
    "compilerOptions": {"noEmit": True, "strict": True, "allowImportingTsExtensions": True},
    "files": [str(project / "tools/scripting-web-globals.d.ts")],
    "include": [str(declarations / "global.d.ts"), str(project / "**/*.ts"), str(project / "**/*.tsx")],
    "exclude": [str(project / "tests"), str(project / "tools")],
}
output.write_text(json.dumps(config), encoding="utf-8")
PY

"${TSC:-tsc}" --project "$temp_dir/tsconfig.json"
