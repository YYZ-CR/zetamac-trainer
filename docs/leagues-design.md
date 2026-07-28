# Private leagues — design

A named group with an invite code and its own leaderboard.

## Why this beats a global board

A global leaderboard attracts; a private league converts. Being 4,000th behind
strangers is information, not motivation. Being 3rd of 6 behind people you know is
the entire reason anyone practises.

It is also the strongest organic acquisition path in the roadmap: one person creates
a league and personally recruits four more. Nothing else here has that shape.

And it matches how the audience already behaves — people prepping for trading
interviews, competition maths teams, a desk that shares scores. Today that group
coordinates by screenshotting each other.

## The leaderboard is over the daily

A league board ranks members **by their result on the day's puzzle**, because the
daily is the only comparison in this product that is already fair — same questions,
one attempt, server-timed. Ranking by personal best would rank by who played most.

Three scopes:

- `today` — the day's puzzle. The default, and the reason to come back.
- `week` — mean daily score over the last 7 puzzles, with a games-played count so a
  single lucky day cannot top it.
- `best` — best-ever daily score. The trophy cabinet.

Members who did not play today appear at the bottom marked "hasn't played", not
omitted. A league of six where two are missing should look like a league of six.

## Membership is the privacy boundary

Joining a league means the other members see your username and your daily scores.
That is the point of joining, and it must be said plainly on the join screen.

It does **not** publish your profile: `profiles.is_public` is untouched, and a league
board links to a member's profile only when they have published it.

Accounts only. A league is a group of known people, and an anonymous member is
neither known nor addressable. This is the one place in the roadmap where requiring
signup is correct rather than costly.

## Schema

```sql
leagues (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_key  TEXT UNIQUE NOT NULL,       -- the invite code, human-shareable
  name        TEXT NOT NULL,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CHECK (char_length(name) BETWEEN 1 AND 60)
)

league_members (
  league_id  UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (league_id, user_id)
)
```

`PRIMARY KEY (league_id, user_id)` makes double-joining a no-op rather than a
duplicate row.

**Caps, enforced in SQL not in the client:** 100 members per league, 20 leagues per
user. Both bound the leaderboard query and stop a single account creating unbounded
rows. A cap that lives in the client is not a cap.

## RPCs

All `SECURITY DEFINER`, `SET search_path = public`. Tables get RLS with no policies
and revoked grants, as with `daily_*` and `duel_*`.

- **`create_league(p_name TEXT) → JSONB`** — creates it, adds the caller as owner and
  first member, returns `{league_key, name}`.
- **`join_league(p_key TEXT) → JSONB`** — idempotent: joining twice is success, not
  an error. Returns the league.
- **`leave_league(p_key TEXT) → JSONB`** — an owner leaving hands ownership to the
  longest-standing remaining member; the last member leaving deletes the league.
  A league with no owner is unreachable, and a league with no members is litter.
- **`get_my_leagues() → JSONB`** — the caller's leagues with member counts, for the
  dashboard.
- **`get_league(p_key TEXT) → JSONB`** — name, member count, whether the caller is a
  member. Enough for a join screen without revealing the roster to a non-member: an
  invite code should not be a directory of who is in it.
- **`get_league_board(p_key TEXT, p_scope TEXT) → JSONB`** — members only. Returns
  rows of `{rank, username, score, played, is_you}` plus the scope echoed back.

## The rules that need explicit tests

- **A non-member cannot read the board.** The invite code gets you a join screen, not
  the roster.
- **A member sees usernames; a non-member sees only a count.**
- **Joining twice is idempotent** and does not duplicate a row or reset `joined_at`.
- **The last member leaving removes the league**, and its key stops resolving.
- **An owner leaving transfers ownership** rather than orphaning the league.
- **Caps are enforced server-side** — the 101st member and the 21st league are
  refused.
- **The board never leaks a `user_id` or an email**, only usernames.
- **A member who has not played today still appears**, marked as such.

## Deliberately not in scope

Per-league chat, invitations by email, private/public league discovery, seasons,
promotion and relegation. Each is a feature in its own right and none is needed for
a league to be worth joining.
