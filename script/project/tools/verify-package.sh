#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT_DIR=$(CDPATH= cd -- "$PROJECT_DIR/.." && pwd)
ARCHIVE=${1:-"$SCRIPT_DIR/pipi-deliveries.scripting"}
EXPECTED_TRACK=${2:-}
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pipi-deliveries-package.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

case "$EXPECTED_TRACK" in
  ""|beta|formal) ;;
  *)
    printf 'Expected package track must be beta or formal\n' >&2
    exit 2
    ;;
esac

unzip -tq "$ARCHIVE" >/dev/null
unzip -q "$ARCHIVE" -d "$TEMP_DIR"

SOURCE_LIST="$TEMP_DIR/.expected-files"
ARCHIVE_LIST="$TEMP_DIR/.archive-files"
{
  printf '%s\n' \
    script.json \
    README.md \
    models.ts \
    index.tsx \
    widget.tsx \
    intent.tsx \
    app_intents.tsx
  find \
    "$PROJECT_DIR/components" \
    "$PROJECT_DIR/pages" \
    "$PROJECT_DIR/services" \
    "$PROJECT_DIR/contracts" \
    "$PROJECT_DIR/assets" \
    "$PROJECT_DIR/widget" \
    -type f \
    | sed "s#^$PROJECT_DIR/##"
} | LC_ALL=C sort > "$SOURCE_LIST"

find "$TEMP_DIR" -type f \
  ! -name '.expected-files' \
  ! -name '.archive-files' \
  | sed "s#^$TEMP_DIR/##" \
  | LC_ALL=C sort > "$ARCHIVE_LIST"

if ! cmp -s "$SOURCE_LIST" "$ARCHIVE_LIST"; then
  printf 'Package file list does not match the current source tree\n' >&2
  diff -u "$SOURCE_LIST" "$ARCHIVE_LIST" >&2 || true
  exit 1
fi

while IFS= read -r relative; do
  if [ "$relative" = README.md ]; then
    SOURCE_FILE="$SCRIPT_DIR/README.md"
  else
    SOURCE_FILE="$PROJECT_DIR/$relative"
  fi
  if ! cmp -s "$SOURCE_FILE" "$TEMP_DIR/$relative"; then
    printf 'Packaged file is stale: %s\n' "$relative" >&2
    exit 1
  fi
done < "$SOURCE_LIST"

for required in \
  script.json \
  README.md \
  index.tsx \
  widget.tsx \
  intent.tsx \
  app_intents.tsx \
  components/EmptyDeliveryVehicle.tsx \
  components/ShipmentRow.tsx \
  pages/HomePage.tsx \
  pages/DetailPage.tsx \
  pages/PhoneBindingPage.tsx \
  pages/DiagnosticLogPage.tsx \
  pages/PhoneManagerPage.tsx \
  pages/PrivacyPage.tsx \
  pages/SettingsPage.tsx \
  services/account-api.ts \
  services/account-carrier-normalization.ts \
  services/account-identity.ts \
  services/account-order-projection.ts \
  services/account-parser.ts \
  services/account-sync.ts \
  services/account-sync-policy.ts \
  services/binding-backup.ts \
  services/build-track.ts \
  services/cainiao-h5.ts \
  services/carrier-presentation.ts \
  services/carrier-query.ts \
  services/credentials.ts \
  services/deadline.ts \
  services/durable-files.ts \
  services/kuaidi100-h5.ts \
  services/kuaidi100-carrier-detection.ts \
  services/manual-preview.ts \
  services/manual-query-order.ts \
  services/manual-query-parser.ts \
  services/manual-query.ts \
  services/logger.ts \
  services/refresh-coordination.ts \
  services/routes.ts \
  services/script-source.ts \
  services/scripting-data.ts \
  services/shipment-policy.ts \
  services/time-presentation.ts \
  widget/SmallWidget.tsx \
  widget/MediumWidget.tsx \
  widget/WidgetLineArt.tsx \
  widget/layout.ts \
  contracts/express-policy.v1.json \
  contracts/express-policy.generated.ts \
  contracts/fixtures/status-packages.v1.json \
  assets/widget/empty-delivery-vehicle.png \
  assets/widget/empty-small-light.png \
  assets/widget/empty-small-dark.png \
  assets/widget/empty-medium-light.png \
  assets/widget/empty-medium-dark.png \
  assets/couriers/default.png \
  assets/couriers/sf.png \
  assets/couriers/zto.png
do
  test -f "$TEMP_DIR/$required" || {
    printf 'Missing package file: %s\n' "$required" >&2
    exit 1
  }
done

if find "$TEMP_DIR" -path '*/tests/*' -o -path '*/tools/*' -o -name 'KDBOT_TOKEN_INTEGRATION.md' | grep -q .; then
  printf 'Development-only files were included in the package\n' >&2
  exit 1
fi

VERSION=$(sed -E -n 's/^[[:space:]]*"version": "([0-9]+(\.[0-9]+)*(-beta[0-9]+)?)",$/\1/p' "$TEMP_DIR/script.json")
BUILD_TRACK=$(sed -E -n 's/^export const SCRIPT_BUILD_TRACK = "([a-z]+)" as const;$/\1/p' "$TEMP_DIR/services/build-track.ts")
SOURCE_VERSION=$(sed -E -n 's/^export const SCRIPT_VERSION = "([0-9]+(\.[0-9]+)*(-beta[0-9]+)?)";$/\1/p' "$TEMP_DIR/services/build-track.ts")
GATEWAY_ORIGIN=$(sed -E -n 's/^export const GATEWAY_ORIGIN = "(https:\/\/[^" ]+)";$/\1/p' "$TEMP_DIR/services/build-track.ts")
test -n "$VERSION" \
  && test "$VERSION" = "$SOURCE_VERSION" || {
  printf 'Package and source versions differ\n' >&2
  exit 1
}

case "$BUILD_TRACK" in
  beta)
    case "$VERSION" in
      *-beta[0-9]*) ;;
      *)
        printf 'Beta package version must end with -beta followed by a number\n' >&2
        exit 1
        ;;
    esac
    test "$GATEWAY_ORIGIN" = 'https://beta.pipiassistant.app' || {
      printf 'Beta package must use the beta gateway\n' >&2
      exit 1
    }
    ;;
  formal)
    case "$VERSION" in
      *-beta[0-9]*)
        printf 'Formal package version must not use a beta suffix\n' >&2
        exit 1
        ;;
    esac
    test "$GATEWAY_ORIGIN" = 'https://pipiassistant.app' || {
      printf 'Formal package must use the formal gateway\n' >&2
      exit 1
    }
    ;;
  *)
    printf 'Unknown package build track\n' >&2
    exit 1
    ;;
esac

if [ -n "$EXPECTED_TRACK" ] && [ "$BUILD_TRACK" != "$EXPECTED_TRACK" ]; then
  printf 'Package track is %s, expected %s\n' "$BUILD_TRACK" "$EXPECTED_TRACK" >&2
  exit 1
fi

FORBIDDEN_MATERIAL='sct1\.|SCRIPTING_TEST_TOKEN|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
if rg -n -i "$FORBIDDEN_MATERIAL" "$TEMP_DIR" >/dev/null; then
  printf 'Forbidden upstream or credential material found in package\n' >&2
  exit 1
fi

NETWORK_URLS=$(rg -I -o --no-filename 'https?://[^[:space:]"<>)]+' "$TEMP_DIR" || true)
while IFS= read -r network_url; do
  test -n "$network_url" || continue
  case "$network_url" in
    "$GATEWAY_ORIGIN"|\
    'https://m.kuaidi100.com/query'|\
    'https://www.kuaidi100.com/autonumber/autoComNum'|\
    'https://github.com/HotKids'|\
    'https://github.com/HotKids/'*|\
    'https://raw.githubusercontent.com/HotKids/pipi-deliveries/main/script/pipi-deliveries.scripting'|\
    'http://www.w3.org/2000/svg') ;;
    *)
      printf 'Unexpected network URL found in package: %s\n' "$network_url" >&2
      exit 1
      ;;
  esac
done <<EOF
$NETWORK_URLS
EOF

printf 'Package verified: %s (%s, %s)\n' "$ARCHIVE" "$VERSION" "$BUILD_TRACK"
