#!/usr/bin/env bash
# Drive real concurrent sessions at the 100-member league cap.
#
# A cap enforced by "count, then insert" lets N simultaneous joiners all read
# 99 and all insert, landing at 99+N. Ten sessions fire at a shared wall-clock
# instant against a league holding exactly 99; exactly one may get in.
#
#   ZT_SU=1 PGHOST=/var/run/postgresql PGPORT=5433 supabase/test/race-league-cap.sh
set -uo pipefail

DB="${ZT_TEST_DB:-zt_test}"
PGENV="PGHOST='${PGHOST:-/var/run/postgresql}' PGPORT='${PGPORT:-5432}'"
P="psql -t -A -d $DB"
Q() { su postgres -c "$PGENV $P -c \"$1\"" 2>&1; }

FAILED=0
for round in 1 2 3; do
  OWNER=$(Q "SELECT id FROM profiles WHERE username='bulk10$round';" | tail -1 | tr -d ' ')
  CODE=$(Q "SET request.jwt.claim.sub='$OWNER'; SELECT public.create_league('Race $round')->>'league_key';" | tail -1 | tr -d ' ')

  # Fill to exactly 99 (the owner is already member 1) with a direct insert.
  # The fill is SETUP, not the thing under test — the test is what happens when
  # concurrent join_league calls hit the boundary — so it does not need to go
  # through the RPC, and going through it here cost a lot of nested-quoting
  # grief for nothing. These are real rows, which is all the cap counts.
  Q "INSERT INTO public.league_members (league_id, user_id)
     SELECT g.id, p.id
       FROM public.leagues g
       JOIN public.profiles p ON p.username LIKE 'bulk%'
      WHERE g.league_key = '$CODE'
        AND p.id <> g.owner_id
        AND p.username NOT IN ('bulk207','bulk208','bulk209','bulk210','bulk211',
                               'bulk212','bulk213','bulk214','bulk215','bulk216')
      ORDER BY p.username
      LIMIT 98
     ON CONFLICT DO NOTHING;" >/dev/null

  FILLED=$(Q "SELECT COUNT(*) FROM league_members m JOIN leagues g ON g.id=m.league_id WHERE g.league_key='$CODE';" | tail -1 | tr -d ' ')
  echo "round $round: code=$CODE filled=$FILLED"

  # A race against a league that is not actually full proves nothing. This
  # precondition is fatal on purpose.
  if [ "$FILLED" != "99" ]; then
    echo "  *** SETUP FAILED: league holds $FILLED, expected 99 — race not run ***"
    FAILED=1; continue
  fi

  GO=$(Q "SELECT (NOW() + INTERVAL '2 seconds')::TEXT;" | tail -1)
  for i in $(seq 1 10); do
    U=$(Q "SELECT id FROM profiles WHERE username='bulk$((206 + i))';" | tail -1 | tr -d ' ')
    su postgres -c "$PGENV $P -c \"
      SET request.jwt.claim.sub='$U';
      SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (TIMESTAMPTZ '$GO' - clock_timestamp()))));
      SELECT public.join_league('$CODE')::text;
    \"" >/tmp/lrace-$i.out 2>/tmp/lrace-$i.err &
  done
  wait

  FINAL=$(Q "SELECT COUNT(*) FROM league_members m JOIN leagues g ON g.id=m.league_id WHERE g.league_key='$CODE';" | tail -1 | tr -d ' ')
  WON=$(grep -l 'league_key' /tmp/lrace-*.out 2>/dev/null | wc -l)
  REFUSED=$(grep -c . /tmp/lrace-*.err 2>/dev/null | grep -v ':0$' | wc -l)
  echo "  final=$FINAL winners=$WON refused_with_error=$REFUSED"

  if [ "$FINAL" != "100" ]; then
    echo "  *** WRONG FINAL COUNT: $FINAL, expected exactly 100 ***"; FAILED=1
  fi
  rm -f /tmp/lrace-*.out /tmp/lrace-*.err
done

if [ "$FAILED" = "0" ]; then
  echo "PASS: the cap held under concurrent joins in every round"
else
  echo "FAIL: concurrent joiners pushed the league past its cap"
  exit 1
fi
