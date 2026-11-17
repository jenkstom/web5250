# Session recording & replay

*Recording, replay and retention*

A system with **Recording** enabled in the admin editor lets its users
record sessions. Nothing is captured by default: the owner clicks the
top-bar **REC** button to start and clicks it again to stop. While a
recording runs, the gateway stores exactly the outbound wire stream — full
screen snapshots (one per host screen; these are the player's seek
points), cell diffs, OIA states, statuses, named keys with their origin,
notice and assist events — as one JSON frame per line on the data volume,
with SQLite metadata. Retention mirrors the spool store: newest
`RECORDINGS_MAX_COUNT` recordings, `RECORDINGS_MAX_BYTES` total,
`RECORDINGS_TTL_MS` age, drop-oldest. A restart also cleans up after a
crash: recordings left live by a dead writer are finalized (aged from the
file's last write) and files with no metadata row are removed, and one
retention sweep runs at boot so nothing stale waits for the next tick.

**A replay contains exactly what a view-only mirror would have seen —
nothing more.** Password fields are blanked by the wire encoder *before*
the recorder runs; keys typed into hidden fields leave no recoverable
trace. Recording is per-system opt-in and owner-only — mirrors cannot
start or stop one — and every start, stop and console removal is audited.

- **Users** replay their own finished sessions from the top-bar
  **History** button (needs `TRUSTED_USER_HEADER`, which is what makes
  "own" mean anything) and can mint replay links for their recordings.
- **Admins** replay everything from the console's Recordings tab, download
  JSONL, mint links, and **Remove** recordings entirely (file, metadata and
  every replay link die together; a still-live recording is stopped first,
  which also clears the session's REC marker). Removal is audited.
- **Replay links** are unguessable bearer tokens (`?replay=<token>`) under
  the same trust model as share links; they are revocable (console or by
  outliving their recording) and the player is the terminal renderer
  itself — scrub bar, 1×–16× speed, a clickable event lane (keys, assist
  grants, notices) and wall-clock timestamps.
