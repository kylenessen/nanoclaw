#!/bin/bash
# search_events.sh - Search calendar events by keyword
# Usage:
#   ./search_events.sh QUERY [options] [format]
#
# Options:
#   -c, --calendar NAME  Filter by calendar name
#   -n, --limit N        Max results (default: 20)
#
# Formats:
#   tsv (default)        Tab-separated values
#   markdown             Markdown formatted list
#   json                 JSON array
#
# Examples:
#   ./search_events.sh "meeting"
#   ./search_events.sh "dentist" -c "Work" markdown

set -e

if [ $# -lt 1 ]; then
    echo "Usage: $0 QUERY [options] [format]" >&2
    exit 1
fi

query="$1"
shift

calendar_filter=""
limit=20
format="tsv"

while [ $# -gt 0 ]; do
    case "$1" in
        -c|--calendar)
            calendar_filter="$2"
            shift 2
            ;;
        -n|--limit)
            limit="$2"
            shift 2
            ;;
        tsv|markdown|json)
            format="$1"
            shift
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

# Build clauses
query_esc=$(echo "$query" | sed "s/'/''/g")
cal_clause=""
if [ -n "$calendar_filter" ]; then
    cal_esc=$(echo "$calendar_filter" | sed "s/'/''/g")
    cal_clause="AND c.title = '$cal_esc'"
fi

result=$(sqlite3 -separator '|' "$CALDB" "
SELECT c.title, ci.summary,
       datetime(ci.start_date + 978307200, 'unixepoch', 'localtime'),
       datetime(ci.end_date + 978307200, 'unixepoch', 'localtime'),
       COALESCE(l.title, 'missing value'),
       COALESCE(REPLACE(REPLACE(substr(ci.description, 1, 200), char(10), ' '), char(13), ' '), 'missing value')
FROM CalendarItem ci
JOIN Calendar c ON ci.calendar_id = c.ROWID
LEFT JOIN Location l ON ci.location_id = l.ROWID
WHERE (ci.summary LIKE '%$query_esc%' OR ci.description LIKE '%$query_esc%')
  $cal_clause
ORDER BY ci.start_date DESC
LIMIT $limit;
" 2>/dev/null) || {
    echo "Error: Failed to search calendar database" >&2
    exit 1
}

if [ -z "$result" ]; then
    case "$format" in
        tsv|markdown)
            echo "No events found matching '$query'"
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
        echo "# Search Results for \"$query\""
        echo ""
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
