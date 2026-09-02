#!/usr/bin/env bash
# Native Deliveries build entrypoint.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-beta}"

resolve_java_home() {
  local candidate="${JAVA_HOME:-}"
  local major=""

  if [[ -x "$candidate/bin/java" ]]; then
    major="$("$candidate/bin/java" -XshowSettings:properties -version 2>&1 \
      | sed -n 's/^[[:space:]]*java\.specification\.version = //p' \
      | head -n 1)"
  fi

  if [[ ! "$major" =~ ^[0-9]+$ ]] || (( major < 21 )); then
    candidate=""
  fi

  if [[ ! -x "$candidate/bin/java" ]] && command -v brew >/dev/null 2>&1; then
    candidate="$(brew --prefix openjdk@21 2>/dev/null || true)"
    if [[ -x "$candidate/libexec/openjdk.jdk/Contents/Home/bin/java" ]]; then
      candidate="$candidate/libexec/openjdk.jdk/Contents/Home"
    fi
  fi

  if [[ ! -x "$candidate/bin/java" ]] && [[ -x /usr/libexec/java_home ]]; then
    candidate="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  fi

  if [[ ! -x "$candidate/bin/java" ]]; then
    printf '%s\n' 'JDK 21 was not found. Install it with: brew install openjdk@21' >&2
    exit 1
  fi

  JAVA_HOME="$candidate"
  PATH="$JAVA_HOME/bin:$PATH"
  export JAVA_HOME PATH
}

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

configure_beta_build() {
  local beta_number
  local release_version
  local major
  local minor
  local patch
  local beta_patch

  beta_number="$(sed -n \
    's/^export const SCRIPT_VERSION = "[0-9][0-9.]*-beta\([0-9][0-9]*\)";$/\1/p' \
    "$ROOT/script/project/services/build-track.ts" | head -n 1)"
  [[ -n "$beta_number" ]] || {
    printf '%s\n' 'The Scripting source is not on a numbered beta track.' >&2
    exit 1
  }

  release_version="$(sed -n \
    's/^val releaseVersionNameDefault = "\([0-9][0-9.]*\)"$/\1/p' \
    "$ROOT/app/build.gradle.kts" | head -n 1)"
  IFS=. read -r major minor patch <<< "$release_version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || {
    printf '%s\n' 'The Android release version must use major.minor.patch.' >&2
    exit 1
  }

  beta_patch=$((patch + 1))
  DELIVERIES_VERSION_NAME="${major}.${minor}.${beta_patch}-beta${beta_number}"
  DELIVERIES_VERSION_CODE=$((major * 1000000 + minor * 10000 + beta_patch * 100))
  DELIVERIES_EXPRESS_GATEWAY_URL="https://beta.pipiassistant.app"
  export DELIVERIES_VERSION_NAME DELIVERIES_VERSION_CODE DELIVERIES_EXPRESS_GATEWAY_URL
}

resolve_local_properties() {
  local worktree
  local candidate

  if [[ -n "${DELIVERIES_LOCAL_PROPERTIES_FILE:-}" ]]; then
    [[ -f "$DELIVERIES_LOCAL_PROPERTIES_FILE" ]] || {
      printf 'DELIVERIES_LOCAL_PROPERTIES_FILE does not exist: %s\n' \
        "$DELIVERIES_LOCAL_PROPERTIES_FILE" >&2
      exit 1
    }
    return
  fi

  if [[ -f "$ROOT/local.properties" ]]; then
    DELIVERIES_LOCAL_PROPERTIES_FILE="$ROOT/local.properties"
    export DELIVERIES_LOCAL_PROPERTIES_FILE
    return
  fi

  while IFS= read -r worktree; do
    candidate="$worktree/local.properties"
    if [[ -f "$candidate" ]]; then
      DELIVERIES_LOCAL_PROPERTIES_FILE="$candidate"
      export DELIVERIES_LOCAL_PROPERTIES_FILE
      return
    fi
  done < <(git -C "$ROOT" worktree list --porcelain 2>/dev/null \
    | sed -n 's/^worktree //p')
}

resolve_android_sdk() {
  local candidate="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  local properties_file="${DELIVERIES_LOCAL_PROPERTIES_FILE:-}"

  if [[ ! -d "$candidate" ]] && [[ -f "$properties_file" ]]; then
    candidate="$(sed -n \
      's/^[[:space:]]*sdk\.dir[[:space:]]*=[[:space:]]*//p' \
      "$properties_file" | head -n 1)"
  fi

  if [[ ! -d "$candidate" ]] && [[ -d "$HOME/Library/Android/sdk" ]]; then
    candidate="$HOME/Library/Android/sdk"
  fi

  if [[ ! -d "$candidate" ]]; then
    printf '%s\n' \
      'Android SDK was not found. Set ANDROID_HOME or sdk.dir in local.properties.' \
      >&2
    exit 1
  fi

  ANDROID_HOME="$candidate"
  ANDROID_SDK_ROOT="$candidate"
  export ANDROID_HOME ANDROID_SDK_ROOT
}

resolve_java_home
resolve_local_properties
resolve_android_sdk

case "$MODE" in
  beta)
    configure_beta_build
    load_release_signing
    "$ROOT/gradlew" -p "$ROOT" \
      :app:testStandardDebugUnitTest \
      :app:testCompatDebugUnitTest \
      :app:lintStandardDebug :app:lintCompatDebug \
      :app:assembleStandardRelease :app:assembleCompatRelease
    mkdir -p "$ROOT/dist"
    cp "$ROOT/app/build/outputs/apk/standard/release/app-standard-release.apk" \
      "$ROOT/dist/Pipi-Deliveries-beta.apk"
    cp "$ROOT/app/build/outputs/apk/compat/release/app-compat-release.apk" \
      "$ROOT/dist/Pipi-Deliveries-beta-Android10.apk"
    echo "Track: beta"
    echo "Version: $DELIVERIES_VERSION_NAME ($DELIVERIES_VERSION_CODE)"
    echo "APK: $ROOT/dist/Pipi-Deliveries-beta.apk"
    echo "APK: $ROOT/dist/Pipi-Deliveries-beta-Android10.apk"
    ;;
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
      "$ROOT/dist/Pipi-Deliveries.apk"
    cp "$ROOT/app/build/outputs/apk/compat/release/app-compat-release.apk" \
      "$ROOT/dist/Pipi-Deliveries-Android10.apk"
    echo "APK: $ROOT/dist/Pipi-Deliveries.apk"
    echo "APK: $ROOT/dist/Pipi-Deliveries-Android10.apk"
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
    echo "Usage: $0 [beta|debug|compat|release|check|clean]" >&2
    exit 2
    ;;
esac
