# Deleting an account

The contract for `supabase/account.sql` and the Danger zone on the settings page.
Client and database are both built against this file.

A half-done delete is worse than none: it leaves a name on a leaderboard nobody can
remove, or it takes a league down with it. This document exists so that every row
that mentions the account has a stated fate.

## The rule

**A deleted account leaves no row that identifies it, and leaves every other
player's data in the most coherent state reachable without that account.**

Where those two pull against each other, the second loses. Nobody else's history is
worth keeping a deleted person's name on the site.

## Why this cannot be a plain `DELETE FROM auth.users`

Two foreign keys make the naive delete actively destructive:

| Column | On delete | Consequence if left to the cascade |
|---|---|---|
| `leagues.owner_id` | `CASCADE` | **The whole league disappears**, taking every other member's board with it, because one member happened to own it. |
| `game_sessions.user_id` | `SET NULL` | The rows survive, unowned, and keep feeding the global percentile — a deleted account still moves everybody else's ranking. |

So the function does the work in order, by hand, and deletes the `auth.users` row
last.

## `delete_account(p_confirm TEXT) → JSONB`

`SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` granted to `authenticated`
only. There is no anonymous account to delete.

### Confirmation

`p_confirm` must equal the caller's current username, compared case-insensitively
after trimming. An account with no username confirms with the literal `DELETE`.

This is not theatre. The argument is what stops a mis-wired button, a double-fired
event, or a stray retry from destroying an account: the call cannot succeed unless
the caller supplied a string only the account holder is looking at.

A mismatch returns `{ok: false, error: 'confirm_mismatch'}`. It does **not** raise —
same convention as `set_username`, where a user error is a payload and only a
programming error is an exception.

### Order of operations

All of it inside one transaction, which a function body already is. Either the
account is gone and everything above is settled, or nothing happened.

1. **Lock.** `SELECT ... FOR UPDATE` the caller's `profiles` row, so two concurrent
   deletes cannot both run the league transfer.
2. **Leagues.** For every league the caller is a member of, apply exactly the rule
   `leave_league` already implements, in this order:
   - remove the membership row;
   - if no members remain, delete the league;
   - else if the caller owned it, transfer ownership to the longest-standing
     remaining member (`ORDER BY joined_at ASC, user_id ASC`).

   The rule is duplicated rather than shared because `leave_league` takes a league
   key and raises `league_not_member`; a loop over "every league" wants neither. If
   the rule changes, both change — `05-leagues-test.sql` and the account suite both
   assert it.
3. **Duels created by the caller** are deleted, with their runs.

   Stated plainly because it costs somebody else something: if an opponent played
   that duel, their result goes too. A duel is the creator's object — their key,
   their question sequence, their expiry — and it is reachable only by its own URL.
   A page owned by a deleted account resolving to "no such duel" is coherent; a
   duel showing a result against a player who no longer exists is not.
4. **Duels the caller played as the opponent** are kept. The creator's result is
   theirs, and it does not depend on the opponent still having an account. The
   caller's `duel_runs` row keeps its score and loses its owner — `user_id` is
   `ON DELETE SET NULL`, so the cascade already does the right thing here, and the
   opponent renders as a deleted account rather than vanishing mid-comparison.

   A duel the caller had claimed but never finished releases the slot:
   `opponent_id` is cleared and the unfinished run row is deleted, so the creator's
   link is live again for whatever remains of its 48 hours.
5. **`daily_attempts`** are deleted. The account comes off every daily leaderboard,
   including past days.
6. **`game_sessions`** are deleted rather than orphaned, so the account stops
   contributing to the global percentile field.
7. **`profiles`** row deleted, which frees the username for anyone else.
8. **`auth.users`** row deleted last. Supabase's own `auth.identities`,
   `auth.sessions` and `auth.refresh_tokens` cascade from it.

### Return payload

```json
{
  "ok": true,
  "leagues_left": 3,
  "leagues_deleted": 1,
  "leagues_transferred": 1,
  "duels_deleted": 4,
  "duel_slots_released": 1,
  "daily_attempts_deleted": 12,
  "sessions_deleted": 240
}
```

Counts, not because anyone needs them, but because a test that asserts on them
catches a step that silently did nothing. On `{ok: false}` only `error` is present.

### What it must not do

- Never take an id from the client. The account deleted is `auth.uid()`, always.
- Never leave a league without an owner, and never delete a league that still has
  members.
- Never return anything about another user.

## The client

A **Danger zone** at the bottom of `settings.html`, visually separated and last on
the page, because a destructive control adjacent to a save button is a bug waiting
to happen.

- Collapsed behind a "Delete account" button; opening it reveals the confirmation
  field and the consequences in plain words.
- The field must be typed exactly — the button stays disabled until it matches. The
  page pre-states the string to type (the username, or `DELETE`).
- The consequences are listed before the field, not after: scores and daily
  attempts gone, leagues owned handed on or removed, duels created removed, the
  username released, and **this cannot be undone**.
- On success: `supabase.auth.signOut()` immediately — the JWT stays valid until it
  expires otherwise — then redirect to the home page. Signing out is not optional
  and not deferred to the next page load.
- On `confirm_mismatch`: an inline message, no navigation.
- On any network failure: say the account was **not** deleted. An ambiguous message
  after a failed delete is the worst possible copy.
