#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$PROJECT_DIR"
node "$PROJECT_DIR/tools/generate-contract.mjs" --check
# R5-NEW-11 ⑧: Node 26 removed --experimental-transform-types. Where Node no longer accepts it, the tests run without
# it and tools/ts-loader.mjs transforms the TypeScript sources itself.
TRANSFORM_TYPES=""
if node --experimental-transform-types -e "" >/dev/null 2>&1; then
  TRANSFORM_TYPES="--experimental-transform-types"
fi
for test_file in tests/*.test.ts; do
  node \
    --no-warnings \
    $TRANSFORM_TYPES \
    --experimental-loader "$PROJECT_DIR/tools/ts-loader.mjs" \
    "$test_file"
done
