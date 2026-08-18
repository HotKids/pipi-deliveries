#!/usr/bin/env bash
# Native Deliveries build entrypoint.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-release}"

load_release_signing() {
  local signing_account
  local signing_project_name
  signing_account="$(id -un)"
  signing_project_name="$(sed -n 's/^rootProject.name = "\([^"]*\)"/\1/p' \
    "$ROOT/settings.gradle.kts" | head -n 1)"

  : "${SIGNING_STORE_FILE:=$HOME/.android/${signing_project_name}-release.jks}"
  : "${SIGNING_KEY_ALIAS:=$signing_project_name}"
  if [[ -z "${SIGNING_STORE_PASSWORD:-}" ]] && command -v security >/dev/null 2>&1; then
    SIGNING_STORE_PASSWORD="$(security find-generic-password \
      -a "$signing_account" -s "${signing_project_name}-release-store" -w 2>/dev/null || true)"
  fi
  if [[ -z "${SIGNING_KEY_PASSWORD:-}" ]] && command -v security >/dev/null 2>&1; then
    SIGNING_KEY_PASSWORD="$(security find-generic-password \
      -a "$signing_account" -s "${signing_project_name}-release-key" -w 2>/dev/null || true)"
  fi
  export SIGNING_STORE_FILE SIGNING_STORE_PASSWORD SIGNING_KEY_PASSWORD SIGNING_KEY_ALIAS
}

case "$MODE" in
  debug)
    "$ROOT/gradlew" -p "$ROOT" :app:assembleStandardDebug
    echo "APK: $ROOT/app/build/outputs/apk/standard/debug/app-standard-debug.apk"
    ;;
  compat)
    "$ROOT/gradlew" -p "$ROOT" :app:assembleCompatDebug
    echo "APK: $ROOT/app/build/outputs/apk/compat/debug/app-compat-debug.apk"
    ;;
  release)
    load_release_signing
    "$ROOT/gradlew" -p "$ROOT" \
      :app:testStandardDebugUnitTest \
      :app:testCompatDebugUnitTest \
      :app:lintStandardDebug :app:lintCompatDebug \
      :app:assembleStandardRelease :app:assembleCompatRelease
    mkdir -p "$ROOT/dist"
    cp "$ROOT/app/build/outputs/apk/standard/release/app-standard-release.apk" \
      "$ROOT/dist/Deliveries.apk"
    cp "$ROOT/app/build/outputs/apk/compat/release/app-compat-release.apk" \
      "$ROOT/dist/Deliveries-Android10.apk"
    echo "APK: $ROOT/dist/Deliveries.apk"
    echo "APK: $ROOT/dist/Deliveries-Android10.apk"
    ;;
  check)
    load_release_signing
    "$ROOT/gradlew" -p "$ROOT" \
      :app:testStandardDebugUnitTest \
      :app:testCompatDebugUnitTest \
      :app:lintStandardDebug :app:lintCompatDebug \
      :app:assembleStandardDebug :app:assembleCompatDebug \
      :app:assembleStandardRelease :app:assembleCompatRelease
    ;;
  clean)
    "$ROOT/gradlew" -p "$ROOT" clean
    ;;
  *)
    echo "Usage: $0 [debug|compat|release|check|clean]" >&2
    exit 2
    ;;
esac
