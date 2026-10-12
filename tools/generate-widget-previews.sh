#!/bin/sh
set -eu

case "$#:${1:-all}" in
  0:all|1:all) preview_size=all ;;
  1:medium) preview_size=medium ;;
  *) echo "Usage: $0 [all|medium]" >&2; exit 2 ;;
esac

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
chrome_bin=${CHROME_BIN:-}
if [ -z "$chrome_bin" ]; then
  chrome_bin=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)
fi
if [ -z "$chrome_bin" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  chrome_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
[ -x "$chrome_bin" ] || { echo "Set CHROME_BIN to an installed Chromium browser." >&2; exit 1; }
project_dir=$(CDPATH= cd -- "$repo_dir/.." && pwd)
[ -d /Volumes/SAMSUNG ] && [ -w "$project_dir" ] || {
  echo "The external project volume must be mounted and writable." >&2; exit 1;
}
mkdir -p "$project_dir/project-data/tmp"
html_path="$repo_dir/tools/widget-preview.html"
preview_profile=$(mktemp -d "$project_dir/project-data/tmp/pipi-widget-preview.XXXXXX")
trap 'rm -rf "$preview_profile"' EXIT HUP INT TERM

render() {
  size=$1
  theme=$2
  width=$3
  height=$4
  output=$5
  : > "$output"
  "$chrome_bin" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --no-first-run \
    --force-device-scale-factor=1 \
    --user-data-dir="$preview_profile" \
    --disable-background-networking \
    --disable-component-update \
    --default-background-color=00000000 \
    --run-all-compositor-stages-before-draw \
    --window-size="$width,$height" \
    --screenshot="$output" \
    "file://$html_path?size=$size&theme=$theme" >/dev/null 2>&1 &
  chrome_pid=$!
  attempts=0
  while [ ! -s "$output" ] && [ "$attempts" -lt 100 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  sleep 0.2
  kill "$chrome_pid" 2>/dev/null || true
  wait "$chrome_pid" 2>/dev/null || true
  if [ ! -s "$output" ]; then
    echo "Failed to render $size $theme widget preview" >&2
    exit 1
  fi
}

if [ "$preview_size" = all ]; then
  render small light 620 620 \
    "$repo_dir/app/src/main/res/drawable-xxxhdpi/widget_express_2x2_preview.png"
fi
render medium light 1324 620 \
  "$repo_dir/app/src/main/res/drawable-xxxhdpi/widget_express_4x2_preview.png"
if [ "$preview_size" = all ]; then
  render small night 620 620 \
    "$repo_dir/app/src/main/res/drawable-night-xxxhdpi/widget_express_2x2_preview.png"
fi
render medium night 1324 620 \
  "$repo_dir/app/src/main/res/drawable-night-xxxhdpi/widget_express_4x2_preview.png"
