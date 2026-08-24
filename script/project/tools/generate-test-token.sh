#!/bin/sh
set -eu

if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' 'openssl is required' >&2
  exit 1
fi
if ! command -v pbcopy >/dev/null 2>&1; then
  printf '%s\n' 'pbcopy is required on macOS' >&2
  exit 1
fi

token_value=$(openssl rand -base64 12 | tr '+/' '-_' | tr -d '=\n')
token_sha256=$(printf '%s' "$token_value" | openssl dgst -sha256 -r | awk '{print $1}')

printf '%s' "$token_value" | pbcopy
unset token_value

printf '%s\n' 'Test token copied to the macOS clipboard.'
printf 'SCRIPTING_TEST_TOKEN_SHA256=%s\n' "$token_sha256"
