#!/bin/bash
# advance-server-time.sh
#
# Two modes:
#   (no arg) / "set"  : SET the server time to the current offset in .server-time-state.
#                       Does NOT change the offset. Used by starpoint.service ExecStartPost
#                       so restarts keep the same in-game date (no drift on restart).
#   "advance"         : ADVANCE the offset by 3 days (persist it), then set the time.
#                       Used by the daily systemd timer (05:00 KST).
#
# This split fixes the old behaviour where every restart advanced time by +3 days.

STARPOINT_URL="http://localhost:8000"
STATE_FILE="/home/ec2-user/starpoint/.server-time-state"

# Starting date (matches CDN snapshot era)
START_DATE="2023-01-07"
# End date (service end)
END_DATE="2024-07-20"
# Fixed time of day (after event start time of 14:00)
TIME_OF_DAY="15:00:00"

MODE="${1:-set}"

# Read current day offset or start fresh
if [ -f "$STATE_FILE" ]; then
    OFFSET=$(cat "$STATE_FILE")
else
    OFFSET=0
fi

# In advance mode, bump the offset by 3 days BEFORE computing the target date,
# and persist it so the new date sticks across restarts.
if [ "$MODE" = "advance" ]; then
    OFFSET=$((OFFSET + 3))
fi

# Calculate target date (date only, append fixed time)
TARGET_DATE=$(date -u -d "$START_DATE + $OFFSET days" +%Y-%m-%d)

# Wrap around if we've passed the end date
TARGET_EPOCH=$(date -u -d "$TARGET_DATE" +%s)
END_EPOCH=$(date -u -d "$END_DATE" +%s)
if [ "$TARGET_EPOCH" -ge "$END_EPOCH" ]; then
    OFFSET=0
    TARGET_DATE="$START_DATE"
fi

TARGET="${TARGET_DATE}T${TIME_OF_DAY}"

# Persist the (possibly advanced / wrapped) offset. In "set" mode this rewrites the
# same value; in "advance" mode it stores offset+3 so the date persists on next restart.
echo "$OFFSET" > "$STATE_FILE"

# Set the server time
curl -s "${STARPOINT_URL}/api/server/time?time=${TARGET}" > /dev/null

echo "$(date -u +%Y-%m-%dT%H:%M:%S) - [$MODE] Server time set to: $TARGET (offset: $OFFSET days)"
