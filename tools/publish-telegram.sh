#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: publish-telegram.sh TITLE NOTES_FILE ARTIFACT..." >&2
  exit 1
fi
title="$1"
notes="$2"
shift 2
test -s "$notes"
printf '%s' "$title" | jq --raw-input --slurp --exit-status 'length > 0 and length <= 1024' >/dev/null
for file in "$notes" "$@"; do
  if [ ! -f "$file" ] || [ ! -s "$file" ] || [ "$(wc -c < "$file")" -gt 50000000 ]; then
    echo "Telegram release file is missing, empty or exceeds the cloud upload limit" >&2
    exit 1
  fi
done

# Validate Scripting delivery before opening the release credential source.
for file in "$@"; do
  case "$file" in
    *.scripting)
      checker="$(cd "$(dirname "$0")/../script/project/tools" && pwd)/verify-gateway-protocol.py"
      if [ -n "${PIPI_SCRIPTING_WORKER_ARTIFACT:-}" ]; then
        python3 "$checker" "$file" --worker-artifact "$PIPI_SCRIPTING_WORKER_ARTIFACT"
      else
        python3 "$checker" "$file"
      fi
      ;;
  esac
done
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is required}"
api_base="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
request() {
  local method="$1" timeout="$2" result
  shift 2
  if ! result="$(curl --fail --silent --max-time "$timeout" --request POST \
      "${api_base}/${method}" "$@" 2>/dev/null)"; then
    echo "Telegram ${method} request failed" >&2
    return 1
  fi
  printf '%s' "$result"
}
response="$(request getMe 15)"
if ! printf '%s' "$response" | jq --exit-status \
    '.ok == true and .result.is_bot == true and ((.result.username // "" | ascii_downcase) == "pipireleases_bot")' >/dev/null 2>&1; then
  echo "Telegram release bot must be @pipireleases_bot" >&2
  exit 1
fi
bot_id="$(printf '%s' "$response" | jq --exit-status --raw-output '.result.id | select(type == "number")')"
response="$(request getChat 15 --form-string "chat_id=${TELEGRAM_CHAT_ID}")"
printf '%s' "$response" | jq --exit-status '.ok == true and (.result.id | type) == "number"' >/dev/null 2>&1
destination="$(printf '%s' "$response" | jq --raw-output '.result.id')"
chat_type="$(printf '%s' "$response" | jq --raw-output '.result.type')"
response="$(request getChatMember 15 --form-string "chat_id=${destination}" --form-string "user_id=${bot_id}")"
printf '%s' "$response" | jq --exit-status --arg type "$chat_type" --argjson id "$bot_id" \
  '.ok == true and .result.user.id == $id and .result.user.is_bot == true and (.result.status == "creator" or (.result.status == "administrator" and ($type != "channel" or .result.can_post_messages == true)))' >/dev/null 2>&1

for file in "$@"; do
  response="$(request sendDocument 300 --form-string "chat_id=${destination}" \
    --form "document=@${file}" --form-string "caption=${title}")"
  printf '%s' "$response" | jq --exit-status '.ok == true' >/dev/null 2>&1
done
if jq --raw-input --slurp --exit-status 'length <= 4096' "$notes" >/dev/null; then
  response="$(request sendMessage 30 --data-urlencode "chat_id=${destination}" --data-urlencode "text@${notes}")"
else
  response="$(request sendDocument 300 --form-string "chat_id=${destination}" \
    --form "document=@${notes}" --form-string "caption=Release notes")"
fi
printf '%s' "$response" | jq --exit-status '.ok == true' >/dev/null 2>&1
