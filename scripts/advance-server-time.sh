#!/bin/bash
# advance-server-time.sh
# Advances the starpoint server time by 3 days every time it's called.
# Meant to be run daily via cron.

STARPOINT_URL="http://localhost:8000"
STATE_FILE="/home/ec2-user/starpoint/.server-time-state"

# Starting date (first event period in KR version)
START_DATE="2021-07-24T14:00:00"
# End date (service end)
END_DATE="2024-07-20T14:00:00"

# Read current day offset or start fresh
if [ -f "$STATE_FILE" ]; then
    OFFSET=$(cat "$STATE_FILE")
else
    OFFSET=0
fi

# Calculate target date
TARGET=$(date -u -d "$START_DATE + $OFFSET days" +%Y-%m-%dT%H:%M:%S 2>/dev/null)

# Check if we've passed the end date, if so wrap around
TARGET_EPOCH=$(date -u -d "$TARGET" +%s 2>/dev/null)
END_EPOCH=$(date -u -d "$END_DATE" +%s 2>/dev/null)

if [ "$TARGET_EPOCH" -ge "$END_EPOCH" ]; then
    OFFSET=0
    TARGET=$(date -u -d "$START_DATE" +%Y-%m-%dT%H:%M:%S)
fi

# Set the server time
curl -s "${STARPOINT_URL}/api/server/time?time=${TARGET}" > /dev/null

# Advance offset for next run
NEW_OFFSET=$((OFFSET + 3))
echo "$NEW_OFFSET" > "$STATE_FILE"

echo "$(date -u +%Y-%m-%dT%H:%M:%S) - Server time set to: $TARGET (offset: $OFFSET days)"
