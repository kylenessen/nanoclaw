#!/bin/bash
# list_calendars.sh - List all macOS calendars
# Usage:
#   ./list_calendars.sh [format]
#
# Formats:
#   tsv (default)   Tab-separated list
#   json            JSON array
#
# Examples:
#   ./list_calendars.sh
#   ./list_calendars.sh json

set -e

format="${1:-tsv}"

case "$format" in
    tsv)
        osascript -e '
tell application "Calendar"
    set calNames to name of calendars
    set AppleScript'\''s text item delimiters to linefeed
    set output to calNames as text
    set AppleScript'\''s text item delimiters to ""
    return output
end tell'
        ;;

    json)
        calendars=$(osascript -e '
tell application "Calendar"
    set calNames to name of calendars
    set AppleScript'\''s text item delimiters to linefeed
    set output to calNames as text
    set AppleScript'\''s text item delimiters to ""
    return output
end tell')
        echo "["
        first=1
        while IFS= read -r cal; do
            [ -z "$cal" ] && continue
            if [ $first -eq 0 ]; then
                echo ","
            fi
            first=0
            cal_esc=$(echo "$cal" | sed 's/"/\\"/g')
            printf '  "%s"' "$cal_esc"
        done <<< "$calendars"
        echo ""
        echo "]"
        ;;

    *)
        echo "Unknown format: $format" >&2
        echo "Available formats: tsv, json" >&2
        exit 1
        ;;
esac
