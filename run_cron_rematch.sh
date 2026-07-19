#!/bin/bash
cd /Users/mac/.openclaw/workspace/sites/星漫屋
echo "--- cron rematch run $(date) ---" >> /tmp/rematch_cron.log
node rematch.js >> /tmp/rematch_cron.log 2>&1
