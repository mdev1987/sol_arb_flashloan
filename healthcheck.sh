#!/bin/bash
test -f /home/mdev/Programming/sol_arb_flashloan/bot.log || exit 1
find /home/mdev/Programming/sol_arb_flashloan/bot.log -mmin -2 -print -quit 2>/dev/null | grep -q . || exit 1
exit 0
