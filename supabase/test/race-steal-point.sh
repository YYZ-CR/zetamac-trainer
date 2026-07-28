#!/usr/bin/env bash
# Drive two real concurrent sessions at claim_duel_point.
#
# Steal mode's whole claim is that a point goes to whoever ANSWERED first,
# not to whoever's packet arrived first. That is a property of a race, and a
# race is the one thing the contract suite cannot exercise: 08-steal-test.sql
# runs in one session, one statement after another, and can only assert what
# the arbitration does once both claims are already in.
#
# So this fires two processes at a shared wall-clock instant, with the SLOWER
# player deliberately going first. If arbitration were first-message-wins,
# the slower player would take the point.
#
#   supabase/test/race-steal-point.sh
#
# Needs the database supabase/test/run.sh builds. Postgres in this sandbox is
# on socket /var/run/postgresql port 5433.
set -uo pipefail

P="psql -h /var/run/postgresql -p 5433 -d zt_test -t -A -v ON_ERROR_STOP=1"
Q() { su postgres -c "$P -c \"$1\""; }

CREATOR=$(Q "SELECT id FROM profiles WHERE username='hexadecimal';" | tr -d ' ')
OPPO=$(Q "SELECT id FROM profiles WHERE username='neverplayed';" | tr -d ' ')
[ -n "$CREATOR" ] && [ -n "$OPPO" ] || { echo "FATAL: seeded users missing"; exit 1; }

FAILED=0

# One round: build a steal duel with both runs live, then race a claim on
# question $IDX. Echoes "winner elapsed" for the caller to judge.
#
# $1 is the function to call, so the negative control below can substitute an
# arbitration that does not exist.
race_round() {
  local FN="$1" IDX="$2"

  KEY=$(Q "SET request.jwt.claim.sub='$CREATOR';
           SELECT public.create_duel(120, 'steal')->>'duel_key';" | tail -1 | tr -d ' ')
  Q "SET request.jwt.claim.sub='$CREATOR'; SELECT public.start_duel_run('$KEY', NULL);" >/dev/null
  Q "SET request.jwt.claim.sub='$OPPO';    SELECT public.start_duel_run('$KEY', NULL);" >/dev/null

  # Backdate both runs by 10 seconds. Without this the server's own "time
  # since the question became current" is a couple of milliseconds and the
  # clamp flattens both claims to the same number — the race would be won by
  # the clamp rather than decided by the arbitration, and would pass whatever
  # the arbitration did.
  Q "UPDATE duel_runs r SET started_at = started_at - INTERVAL '10 seconds'
     FROM duels d WHERE d.id = r.duel_id AND d.duel_key = '$KEY';" >/dev/null

  ANS=$(Q "SELECT (questions->$IDX->>'answer') FROM duels WHERE duel_key='$KEY';" | tail -1 | tr -d ' ')
  GO=$(Q "SELECT (NOW() + INTERVAL '2 seconds')::TEXT;" | tail -1)

  # The creator is the SLOW one (2400 ms) and starts 150 ms earlier. The
  # opponent is fast (900 ms) and arrives second. Arrival order and answer
  # speed disagree, which is the whole point.
  su postgres -c "$P -c \"
    SET request.jwt.claim.sub='$CREATOR';
    SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (TIMESTAMPTZ '$GO' - clock_timestamp()))));
    SELECT public.$FN('$KEY', NULL, $IDX, 2400, $ANS);
  \"" >/tmp/steal-race-a.out 2>/tmp/steal-race-a.err &

  su postgres -c "$P -c \"
    SET request.jwt.claim.sub='$OPPO';
    SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (TIMESTAMPTZ '$GO' - clock_timestamp())) + 0.15));
    SELECT public.$FN('$KEY', NULL, $IDX, 900, $ANS);
  \"" >/tmp/steal-race-b.out 2>/tmp/steal-race-b.err &
  wait

  ROWS=$(Q "SELECT COUNT(*) FROM duel_points p JOIN duels d ON d.id=p.duel_id
            WHERE d.duel_key='$KEY' AND p.question_index=$IDX;" | tail -1 | tr -d ' ')
  WIN=$(Q "SELECT winner_side||'|'||elapsed_ms FROM duel_points p JOIN duels d ON d.id=p.duel_id
           WHERE d.duel_key='$KEY' AND p.question_index=$IDX;" | tail -1 | tr -d ' ')
  echo "rows=$ROWS winner=$WIN"
}

echo "=== arbitration: the slow claim goes FIRST, the fast claim goes SECOND ==="
for round in 1 2 3; do
  OUT=$(race_round claim_duel_point 0)
  echo "round $round: $OUT"
  case "$OUT" in
    "rows=1 winner=opponent|900") ;;
    *) echo "  *** RACE LOST: expected exactly one row, opponent, 900ms ***"; FAILED=1 ;;
  esac
done

# ── The negative control ──────────────────────────────────────────
# A race test that has never failed proves nothing. This project has shipped
# one of those: a league cap race that reported PASS while its own setup had
# silently skipped most of the members.
#
# So: the same race against arbitration that IS first-message-wins. If the
# harness above cannot tell the two apart, it is not testing anything.
echo
echo "=== negative control: first message wins ==="
su postgres -c "$P -c \"
  CREATE OR REPLACE FUNCTION public.claim_first_wins(
    p_key TEXT, p_guest_token TEXT, p_index INTEGER,
    p_elapsed_ms INTEGER, p_answer NUMERIC DEFAULT NULL)
  RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS \\\$f\\\$
  DECLARE v_d public.duels%ROWTYPE; v_role TEXT;
  BEGIN
    SELECT * INTO v_d FROM public.duels WHERE duel_key = p_key;
    v_role := public.duel_role(v_d.creator_id, v_d.opponent_id,
                               v_d.opponent_guest_token, auth.uid(), p_guest_token);
    INSERT INTO public.duel_points (duel_id, question_index, winner_side, elapsed_ms)
    VALUES (v_d.id, p_index, v_role, GREATEST(p_elapsed_ms, 0))
    ON CONFLICT (duel_id, question_index) DO NOTHING;
    RETURN jsonb_build_object('ok', TRUE);
  END \\\$f\\\$;
\"" >/dev/null 2>&1 || { echo "FATAL: could not create the control function"; exit 1; }

CTL=$(race_round claim_first_wins 0)
echo "control: $CTL"
su postgres -c "$P -c 'DROP FUNCTION IF EXISTS public.claim_first_wins(TEXT,TEXT,INTEGER,INTEGER,NUMERIC);'" >/dev/null

case "$CTL" in
  "rows=1 winner=creator|2400")
    echo "  good: without arbitration the SLOWER player takes the point — the harness can tell them apart" ;;
  *)
    echo "  *** CONTROL DID NOT FAIL AS EXPECTED ($CTL) — this harness proves nothing ***"
    FAILED=1 ;;
esac

rm -f /tmp/steal-race-*.out /tmp/steal-race-*.err
echo
if [ "$FAILED" = "0" ]; then
  echo "PASS: the point went to the faster answer in every round, and the control confirms that was not luck"
  exit 0
fi
echo "FAIL"
exit 1
