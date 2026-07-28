#!/usr/bin/env bash
# Drive real concurrent sessions at start_duel_run.
#
# The claim is guarded by a conditional UPDATE plus a re-read; a naive
# check-then-act would let two guests both take the single opponent slot.
# Twelve processes fire at a shared wall-clock instant, five duels in a row.
set -uo pipefail

P="psql -h /var/run/postgresql -p 5433 -d zt_test -t -A -v ON_ERROR_STOP=1"
Q() { su postgres -c "$P -c \"$1\""; }

CREATOR=$(Q "SELECT id FROM profiles WHERE username='hexadecimal';" | tr -d ' ')
echo "creator=$CREATOR"

FAILED=0
for round in 1 2 3 4 5; do
  KEY=$(Q "SET request.jwt.claim.sub='$CREATOR'; SELECT public.create_duel(120)->>'duel_key';" | tail -1 | tr -d ' ')

  # A shared start instant, ~2s out, so the processes actually overlap
  # instead of queueing behind each other's startup cost.
  GO=$(Q "SELECT (NOW() + INTERVAL '2 seconds')::TEXT;" | tail -1)

  for i in $(seq 1 12); do
    su postgres -c "$P -c \"
      SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (TIMESTAMPTZ '$GO' - clock_timestamp()))));
      SELECT COALESCE(public.start_duel_run('$KEY', 'guest-race-$i')->>'side', 'refused');
    \"" >/tmp/race-$i.out 2>/tmp/race-$i.err &
  done
  wait

  SIDES=$(cat /tmp/race-*.out 2>/dev/null | grep -E '^(creator|opponent|refused)$' | sort | uniq -c | tr '\n' ' ')
  RUNS=$(Q "SELECT COUNT(*) FROM duel_runs r JOIN duels d ON d.id=r.duel_id WHERE d.duel_key='$KEY';" | tail -1 | tr -d ' ')
  OPPS=$(Q "SELECT COUNT(*) FROM duel_runs r JOIN duels d ON d.id=r.duel_id WHERE d.duel_key='$KEY' AND r.side='opponent';" | tail -1 | tr -d ' ')
  DISTINCT=$(Q "SELECT COUNT(DISTINCT r.guest_token) FROM duel_runs r JOIN duels d ON d.id=r.duel_id WHERE d.duel_key='$KEY' AND r.side='opponent';" | tail -1 | tr -d ' ')

  echo "round $round: key=$KEY runs=$RUNS opponent_rows=$OPPS distinct_tokens=$DISTINCT | replies: $SIDES"
  if [ "$OPPS" != "1" ] || [ "$DISTINCT" != "1" ]; then
    echo "  *** RACE LOST: $OPPS opponent rows, $DISTINCT distinct tokens ***"
    FAILED=1
  fi
  rm -f /tmp/race-*.out /tmp/race-*.err
done

if [ "$FAILED" = "0" ]; then
  echo "PASS: exactly one opponent claimed the slot in every round"
else
  echo "FAIL: the opponent slot was claimed more than once"
  exit 1
fi
