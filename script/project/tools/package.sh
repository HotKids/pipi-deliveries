#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT_DIR=$(CDPATH='' cd -- "$PROJECT_DIR/.." && pwd)
OUTPUT=${1:-"$SCRIPT_DIR/pipi-deliveries.scripting"}

case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="$PROJECT_DIR/$OUTPUT" ;;
esac

OUTPUT_DIR=$(CDPATH='' cd -- "$(dirname -- "$OUTPUT")" && pwd)
OUTPUT_NAME=$(basename -- "$OUTPUT")
TEMP_DIR=$(mktemp -d "$OUTPUT_DIR/.pipi-deliveries-package.XXXXXX")
TEMP_OUTPUT="$TEMP_DIR/$OUTPUT_NAME"

cleanup() {
  rm -f "$TEMP_OUTPUT"
  rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

cd "$PROJECT_DIR"
zip -q -j "$TEMP_OUTPUT" "$SCRIPT_DIR/README.md"
zip -q -r "$TEMP_OUTPUT" \
  script.json \
  models.ts \
  index.tsx \
  widget.tsx \
  intent.tsx \
  app_intents.tsx \
  components \
  pages \
  services \
  contracts \
  assets \
  widget

sh "$PROJECT_DIR/tools/verify-package.sh" "$TEMP_OUTPUT" >/dev/null
mv -f "$TEMP_OUTPUT" "$OUTPUT"
rmdir "$TEMP_DIR"
trap - EXIT HUP INT TERM
printf '%s\n' "$OUTPUT"
