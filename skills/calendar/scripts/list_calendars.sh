#!/bin/bash
# list_calendars.sh - List all macOS calendars
# Usage:
#   ./list_calendars.sh [format]
#
# Formats:
#   tsv (default)   One calendar name per line
#   json            JSON array
#
# Examples:
#   ./list_calendars.sh
#   ./list_calendars.sh json

set -e

format="${1:-tsv}"

CALDB="$HOME/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb"

if [ ! -f "$CALDB" ]; then
    echo "Error: Calendar database not found at $CALDB" >&2
    exit 1
fi

result=$(sqlite3 -separator '|' "$CALDB" "
SELECT DISTINCT title FROM Calendar
WHERE title IS NOT NULL AND title != ''
ORDER BY title;
" 2>/dev/null) || {
    echo "Error: Failed to read calendar database" >&2
    exit 1
}

if [ -z "$result" ]; then
    echo "No calendars found"
    exit 0
fi

case "$format" in
    tsv)
        echo "$result"
        ;;
    json)
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
        done <<< "$result"
        echo ""
        echo "]"
        ;;
    *)
        echo "Unknown format: $format" >&2
        exit 1
        ;;
esac
