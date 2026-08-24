#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
chrome_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
html_path="$repo_dir/tools/widget-preview.html"
preview_profile=$(mktemp -d /tmp/pipi-widget-preview.XXXXXX)
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

render small light 640 672 \
  "$repo_dir/app/src/main/res/drawable-xxxhdpi/widget_express_2x2_preview.png"
render medium light 1360 672 \
  "$repo_dir/app/src/main/res/drawable-xxxhdpi/widget_express_4x2_preview.png"
render small night 640 672 \
  "$repo_dir/app/src/main/res/drawable-night-xxxhdpi/widget_express_2x2_preview.png"
render medium night 1360 672 \
  "$repo_dir/app/src/main/res/drawable-night-xxxhdpi/widget_express_4x2_preview.png"
