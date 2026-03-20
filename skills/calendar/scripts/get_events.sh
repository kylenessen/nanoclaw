#!/bin/bash
# get_events.sh - Get calendar events with flexible filtering and formatting
# Usage:
#   ./get_events.sh [options] [format]
#
# Options:
#   --today              Get today's events (default)
#   --week               Get next 7 days
#   --days N             Get next N days
#   -c, --calendar NAME  Filter by calendar name
#
# Formats:
#   tsv (default)        Tab-separated values
#   markdown             Markdown formatted list
#   json                 JSON array
#
# Examples:
#   ./get_events.sh                         # Today's events as TSV
#   ./get_events.sh -c "Work" --week markdown  # Next 7 days from Work calendar
#   ./get_events.sh --days 14 json          # Next 14 days as JSON

set -e

days=0
calendar_filter=""
format="tsv"

while [ $# -gt 0 ]; do
    case "$1" in
        --today)
            days=0
            shift
            ;;
        --week)
            days=7
            shift
            ;;
        --days)
            days="$2"
            shift 2
            ;;
        -c|--calendar)
            calendar_filter="$2"
            shift 2
            ;;
        tsv|markdown|json)
            format="$1"
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [options] [format]"
            echo ""
            echo "Options:"
            echo "  --today              Get today's events"
            echo "  --week               Get next 7 days"
            echo "  --days N             Get next N days"
            echo "  -c, --calendar NAME  Filter by calendar name"
            echo ""
            echo "Formats: tsv (default), markdown, json"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

CALDB="$HOME/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb"

if [ ! -f "$CALDB" ]; then
    echo "Error: Calendar database not found at $CALDB" >&2
    exit 1
fi

# Build calendar filter clause
cal_clause=""
if [ -n "$calendar_filter" ]; then
    cal_esc=$(echo "$calendar_filter" | sed "s/'/''/g")
    cal_clause="AND c.title = '$cal_esc'"
fi

# CoreData epoch: Jan 1, 2001 = 978307200 seconds after Unix epoch
result=$(sqlite3 -separator '|' "$CALDB" "
SELECT c.title, ci.summary,
       datetime(ci.start_date + 978307200, 'unixepoch', 'localtime'),
       datetime(ci.end_date + 978307200, 'unixepoch', 'localtime'),
       COALESCE(l.title, 'missing value'),
       COALESCE(REPLACE(REPLACE(substr(ci.description, 1, 200), char(10), ' '), char(13), ' '), 'missing value')
FROM CalendarItem ci
JOIN Calendar c ON ci.calendar_id = c.ROWID
LEFT JOIN Location l ON ci.location_id = l.ROWID
WHERE date(ci.start_date + 978307200, 'unixepoch', 'localtime') >= date('now', 'localtime')
  AND date(ci.start_date + 978307200, 'unixepoch', 'localtime') <= date('now', 'localtime', '+$days days')
  $cal_clause
ORDER BY ci.start_date;
" 2>/dev/null) || {
    echo "Error: Failed to query calendar database" >&2
    exit 1
}

if [ -z "$result" ]; then
    case "$format" in
        tsv|markdown)
            echo "No events found"
            ;;
        json)
            echo "[]"
            ;;
    esac
    exit 0
fi

case "$format" in
    tsv)
        while IFS='|' read -r cal title start end loc desc; do
            [ -n "$cal" ] && printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$cal" "$title" "$start" "$end" "$loc" "$desc"
        done <<< "$result"
        ;;
    markdown)
        while IFS='|' read -r cal title start end loc desc; do
            if [ -n "$cal" ]; then
                echo "## $title"
                echo "- Calendar: $cal"
                echo "- Start: $start"
                echo "- End: $end"
                if [ -n "$loc" ] && [ "$loc" != "missing value" ]; then
                    echo "- Location: $loc"
                fi
                if [ -n "$desc" ] && [ "$desc" != "missing value" ]; then
                    echo "- Description: $desc"
                fi
                echo ""
            fi
        done <<< "$result"
        ;;
    json)
        echo "["
        first=1
        while IFS='|' read -r cal title start end loc desc; do
            if [ -n "$cal" ]; then
                if [ $first -eq 0 ]; then
                    echo ","
                fi
                first=0
                cal_esc=$(echo "$cal" | sed 's/"/\\"/g')
                title_esc=$(echo "$title" | sed 's/"/\\"/g')
                start_esc=$(echo "$start" | sed 's/"/\\"/g')
                end_esc=$(echo "$end" | sed 's/"/\\"/g')
                loc_esc=$(echo "$loc" | sed 's/"/\\"/g')
                desc_esc=$(echo "$desc" | sed 's/"/\\"/g')
                printf '  {"calendar": "%s", "title": "%s", "start": "%s", "end": "%s", "location": "%s", "description": "%s"}' \
                    "$cal_esc" "$title_esc" "$start_esc" "$end_esc" "$loc_esc" "$desc_esc"
            fi
        done <<< "$result"
        echo ""
        echo "]"
        ;;
    *)
        echo "Unknown format: $format" >&2
        exit 1
        ;;
esac
