#!/bin/bash
# advance-server-time.sh
# Advances the starpoint server time by 3 days every time it's called.
# Meant to be run daily via cron/systemd timer.

STARPOINT_URL="http://localhost:8000"
STATE_FILE="/home/ec2-user/starpoint/.server-time-state"

# Starting date (matches CDN snapshot era)
START_DATE="2023-01-07"
# End date (service end)
END_DATE="2024-07-20"
# Fixed time of day (after event start time of 14:00)
TIME_OF_DAY="15:00:00"

# Read current day offset or start fresh
if [ -f "$STATE_FILE" ]; then
    OFFSET=$(cat "$STATE_FILE")
else
    OFFSET=0
fi

# Calculate target date (date only, append fixed time)
TARGET_DATE=$(date -u -d "$START_DATE + $OFFSET days" +%Y-%m-%d)
TARGET="${TARGET_DATE}T${TIME_OF_DAY}"

# Check if we've passed the end date, if so wrap around
TARGET_EPOCH=$(date -u -d "$TARGET_DATE" +%s)
END_EPOCH=$(date -u -d "$END_DATE" +%s)

if [ "$TARGET_EPOCH" -ge "$END_EPOCH" ]; then
    OFFSET=0
    TARGET="${START_DATE}T${TIME_OF_DAY}"
fi

# Set the server time
curl -s "${STARPOINT_URL}/api/server/time?time=${TARGET}" > /dev/null

# Advance offset for next run
NEW_OFFSET=$((OFFSET + 3))
echo "$NEW_OFFSET" > "$STATE_FILE"

echo "$(date -u +%Y-%m-%dT%H:%M:%S) - Server time set to: $TARGET (offset: $OFFSET days)"
