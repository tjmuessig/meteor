#!/bin/bash

PORT=9000
NUM_CLIENTS=10
DURATION=120
REPORT_INTERVAL=10

set -e
trap "echo XXX FAILED" EXIT

PROJDIR=`dirname $0`
cd "$PROJDIR"
PROJDIR=`pwd`

# clean up from previous runs
# XXX this is gross!
pkill -f "$PROJDIR/.meteor/local/db" || true
../../../meteor reset || true
killall phantomjs || true

# start the benchmark app
../../../meteor --production --port 9000 &
OUTER_PID=$!


# start a bunch of phantomjs processes
PHANTOMSCRIPT=`mktemp -t benchmark-XXXXXXXX`
cat > "$PHANTOMSCRIPT" <<EOF
var page = require('webpage').create();
var url = 'http://localhost:$PORT';
page.open(url);
EOF
for ((i = 0 ; i < $NUM_CLIENTS ; i++)) ; do
    sleep 2
    phantomjs "$PHANTOMSCRIPT" &    # XXX save pid to kill later
done

ps -o cputime,ppid,args | grep "$OUTER_PID" | grep main.js || true
for ((i = 0 ; i < $DURATION/$REPORT_INTERVAL ; i++)) ; do
    sleep $REPORT_INTERVAL
    ps -o cputime,ppid,args | grep "$OUTER_PID" | grep main.js || true
done

kill -INT $OUTER_PID
# XXX kill by pid
killall phantomjs

rm "$PHANTOMSCRIPT"

trap - EXIT

