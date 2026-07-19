#!/bin/bash
cd /Users/mac/.openclaw/workspace/sites/星漫屋
# Run fix_zero.js in background, capture PID, wait up to 90 seconds then kill
node fix_zero.js >> /tmp/fix_zero_cron.log 2>&1 &
PID=$!
sleep 90
kill $PID 2>/dev/null
wait $PID 2>/dev/null
echo "Exit code: $?"
