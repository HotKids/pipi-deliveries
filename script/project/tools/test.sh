#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$PROJECT_DIR"
node "$PROJECT_DIR/tools/generate-contract.mjs" --check
for test_file in tests/*.test.ts; do
  node \
    --no-warnings \
    --experimental-transform-types \
    --experimental-loader "$PROJECT_DIR/tools/ts-loader.mjs" \
    "$test_file"
done
