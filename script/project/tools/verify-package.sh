#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ARCHIVE=${1:-"$PROJECT_DIR/pipi-deliveries.scripting"}
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pipi-deliveries-package.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

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
  if ! cmp -s "$PROJECT_DIR/$relative" "$TEMP_DIR/$relative"; then
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
  services/account-identity.ts \
  services/account-order-projection.ts \
  services/account-parser.ts \
  services/account-sync.ts \
  services/account-sync-policy.ts \
  services/binding-backup.ts \
  services/carrier-presentation.ts \
  services/carrier-query.ts \
  services/credentials.ts \
  services/deadline.ts \
  services/durable-files.ts \
  services/manual-preview.ts \
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

VERSION=$(sed -n 's/^[[:space:]]*"version": "\([0-9][0-9.]*\)",$/\1/p' "$TEMP_DIR/script.json")
CLIENT_VERSION=$(sed -n 's/^const SCRIPT_CLIENT_VERSION = "\([0-9][0-9.]*\)";$/\1/p' "$TEMP_DIR/services/account-sync.ts")
SETTINGS_VERSION=$(sed -n 's/^const SCRIPT_VERSION = "\([0-9][0-9.]*\)";$/\1/p' "$TEMP_DIR/pages/SettingsPage.tsx")
test -n "$VERSION" \
  && test "$VERSION" = "$CLIENT_VERSION" \
  && test "$VERSION" = "$SETTINGS_VERSION" || {
  printf 'Package, gateway client and settings versions differ\n' >&2
  exit 1
}

FORBIDDEN_MATERIAL='xia''omi|mei''zu|sct1\.|SCRIPTING_TEST_TOKEN|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
if rg -n -i "$FORBIDDEN_MATERIAL" "$TEMP_DIR" >/dev/null; then
  printf 'Forbidden upstream or credential material found in package\n' >&2
  exit 1
fi

if rg -n 'https?://' "$TEMP_DIR" \
  | grep -v 'https://pipi-gateway.hotki.de' \
  | grep -v 'https://github.com/HotKids' \
  | grep -v 'http://www.w3.org/2000/svg' \
  >/dev/null; then
  printf 'Unexpected network origin found in package\n' >&2
  exit 1
fi

printf 'Package verified: %s (%s)\n' "$ARCHIVE" "$VERSION"
