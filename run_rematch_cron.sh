#!/bin/bash
cd /Users/mac/.openclaw/workspace/sites/星漫屋
node rematch.js >> /tmp/rematch_cron.log 2>&1
echo "EXIT_CODE=$?"
