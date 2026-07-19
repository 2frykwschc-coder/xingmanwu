#!/bin/bash
cd /Users/mac/.openclaw/workspace/sites/星漫屋
echo "=== $(date) - Rematch cron run ===" >> /tmp/rematch_cron.log
node rematch.js >> /tmp/rematch_cron.log 2>&1
