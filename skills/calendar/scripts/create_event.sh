#!/bin/bash
# create_event.sh - Create a new calendar event
# Usage:
#   ./create_event.sh TITLE START_DATE END_DATE [CALENDAR] [LOCATION] [DESCRIPTION]
#
# Date Format: YYYY-MM-DD HH:MM (24-hour format)
#
# Examples:
#   ./create_event.sh "Team Meeting" "2025-12-26 14:00" "2025-12-26 15:00"
#   ./create_event.sh "Lunch" "2025-12-27 12:00" "2025-12-27 13:00" "Work"
#   ./create_event.sh "Conference" "2025-12-28 09:00" "2025-12-28 17:00" "Work" "San Francisco" "Annual conference"

set -e

if [ $# -lt 3 ]; then
    echo "Usage: $0 TITLE START_DATE END_DATE [CALENDAR] [LOCATION] [DESCRIPTION]" >&2
    echo "" >&2
    echo "Date Format: YYYY-MM-DD HH:MM (24-hour format)" >&2
    exit 1
fi

title="$1"
start_date="$2"
end_date="$3"
calendar="${4:-Calendar}"
location="${5:-}"
description="${6:-}"

# Validate date format
validate_date() {
    if ! date -j -f "%Y-%m-%d %H:%M" "$1" > /dev/null 2>&1; then
        echo "Error: Invalid date format '$1'. Expected: YYYY-MM-DD HH:MM" >&2
        exit 1
    fi
}

validate_date "$start_date"
validate_date "$end_date"

# Parse dates into components for JXA
start_year=$(date -j -f "%Y-%m-%d %H:%M" "$start_date" "+%Y")
start_month=$(date -j -f "%Y-%m-%d %H:%M" "$start_date" "+%-m")
start_day=$(date -j -f "%Y-%m-%d %H:%M" "$start_date" "+%-d")
start_hour=$(date -j -f "%Y-%m-%d %H:%M" "$start_date" "+%-H")
start_minute=$(date -j -f "%Y-%m-%d %H:%M" "$start_date" "+%-M")

end_year=$(date -j -f "%Y-%m-%d %H:%M" "$end_date" "+%Y")
end_month=$(date -j -f "%Y-%m-%d %H:%M" "$end_date" "+%-m")
end_day=$(date -j -f "%Y-%m-%d %H:%M" "$end_date" "+%-d")
end_hour=$(date -j -f "%Y-%m-%d %H:%M" "$end_date" "+%-H")
end_minute=$(date -j -f "%Y-%m-%d %H:%M" "$end_date" "+%-M")

# Escape for JXA
title_esc=$(echo "$title" | sed "s/'/\\\\'/g")
cal_esc=$(echo "$calendar" | sed "s/'/\\\\'/g")
loc_esc=$(echo "$location" | sed "s/'/\\\\'/g")
desc_esc=$(echo "$description" | sed "s/'/\\\\'/g")

timeout 30 osascript -l JavaScript -e "
const Cal = Application('Calendar');
const cal = Cal.calendars.byName('$cal_esc');

const startDate = new Date($start_year, $start_month - 1, $start_day, $start_hour, $start_minute);
const endDate = new Date($end_year, $end_month - 1, $end_day, $end_hour, $end_minute);

const event = Cal.Event({
    summary: '$title_esc',
    startDate: startDate,
    endDate: endDate,
    location: '$loc_esc',
    description: '$desc_esc'
});

cal.events.push(event);
'OK';
" > /dev/null 2>&1 || {
    echo "Error: Failed to create event. Check that calendar '$calendar' exists." >&2
    exit 1
}

echo "Event created successfully!"
echo "  Calendar: $calendar"
echo "  Title: $title"
echo "  Start: $start_date"
echo "  End: $end_date"
if [ -n "$location" ]; then
    echo "  Location: $location"
fi
if [ -n "$description" ]; then
    echo "  Description: $description"
fi
