#!/bin/bash
cd /Users/mac/.openclaw/workspace/sites/星漫屋
node fix_zero.js >> /tmp/fix_zero_cron.log 2>&1
echo "EXIT_CODE=$?"
