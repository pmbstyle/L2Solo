# Clan reputation and discipline

Clan social memory is a directed, bounded projection owned by the clan. It is
separate from a bot's personal character memories and personal clan impressions.
Alliance relationships and formal declarations of war are outside this module.

Migration 38 creates `clan_social_memory`, one snapshot per clan, under the
existing SQLite writer. Accepted personal episodes update clan projections in
the same transaction; rejected or duplicate deliveries produce no extra credit.
Validated significant Adena contributions update the projection in their existing
ledger transaction. The event captures both memberships at the time of the act.
Unknown responsibility and legitimate defense do not produce collective blame.
Provoked aggression has a reduced weight; a monster claim dispute remains the
intruder's responsibility. Native attacks with no established intent are kept
personal rather than guessed to be unprovoked attacks.

Current producers are accepted cold/hot resource disputes, attributed PvP,
successful shared hunts, native healing of a critically injured fighting bot,
native resurrection, cold PvP emergency healing, and meaningful clan Adena
contributions. Ordinary purchases, small gifts, routine buffing, death, weak gear,
and failed farming do not establish misconduct. Rescue producers exclude arenas
and self-healing. A rescue is only recorded after its effect succeeds.
Promises and diplomatic agreements have no implemented gameplay lifecycle yet;
they must gain an authoritative outcome producer before affecting this memory.

There are at most 128 character and 32 clan relations, 256 replay entries,
8 compact evidence entries and 3 reasons per relation. One encounter has capped
severity independent of witnesses and roster size. A death can upgrade that
severity without being a second independent encounter. Repeated contact with one
subject within an hour has reduced weight. Separate persisted daily counters cap
positive credit at 6 and negative credit at 24 per relation; evicting short history
cannot reset those counters. A replay watermark prevents old deliveries from
recreating evicted records. Discipline records have retention priority.

An ordinary member's isolated offense does not condemn the clan. Collective
attribution requires at least two different subjects from that clan and two
different encounters within three days. A leader's own confirmed act may supply
a limited direct representation signal. Historical evidence retains its original
clan attribution when a member changes clans. Trust, hostility, fear and
familiarity are distinct and decay lazily; severe evidence persists longer than
minor disputes. Friendly/hostile states have separate entry/exit thresholds.

Main and worker use `ClanSocialView`: two indexed lookups, bounded arithmetic,
no SQL or population traversal during a decision. A shared versioned IPC page
updates each changed clan once, rather than copying it into every bot snapshot.
Membership has its own version and overrides stale life-state clan IDs. The
runtime polls an indexed change cursor at most once per five seconds when
snapshot work runs; the writer assigns globally increasing change stamps.
Full worker startup replays the current projections. Replay/evidence ledgers are
not sent to workers. Main hydration and worker delivery are eventually consistent;
the admission path never treats reputation as permission to attack.

Resource competition, party preference, party retention and participation now
read effective feelings combining personal history and shared reputation.
Existing friendship moderates collective hostility. Shared membership encourages
support, while a principal's disciplinary status discourages helping another
provocation. Risk, protections and native combat rules still decide whether an
attack is possible. Warnings/probation also reduce the member's own willingness
to provoke, modulated by commitment and empathy; self-defense is unaffected.

## Discipline

Repeated attributed misconduct by a current member lowers the clan's trust in
that member, independently of the outsider's clan reputation. Stage progression
is `clear -> concern -> warned -> probation -> expulsion_pending -> expelled`.
Leader empathy/assertiveness shifts the warning threshold. At most one offense
per half hour can advance discipline; warning and probation each require a later
offense at least an hour afterward. No single battle can expel someone. Positive
acts repair discipline gradually; long peaceful periods decay the score. Warning
and probation notices are persisted as stage timestamps/reasons and are announced
to online clan listeners when the runtime observes a new stage.

The central runtime considers one pending removal at a time under the existing
background admission gate, with retry backoff. It fences the member, settles
queued writes and calls a dedicated removal transaction. That transaction checks
the clan is autonomous, the member is a generated bot and not the leader, the
discipline revision and warning/probation evidence still match, and there is no
worker lease or shared PvP handoff in progress. Player-managed clans and leaders
are not automatically expelled. Ordinary manual membership restrictions remain.

Removal atomically changes character membership, life state and simulation
roster, clears the old clan task, retains both sides' memory and records a
seven-day join restriction. Live actor flags and clan packets are refreshed;
worker snapshots receive the new revision. A membership version protects the
result from stale cold stats. Existing background party membership is not
automatically dissolved by a clan expulsion.

Automatic joining and founding respect the join restriction. Rejoining the old
clan also requires recovered trust/hostility; elapsed time alone cannot override
an active ban. A successful readmission resets discipline while retaining the
previous expulsion timestamp and reputation history. Expulsion adds a personal
clan grievance, not an automatic attack order.

Observer `/observer/api/world/status` includes cached clan-social counts.
`GET /observer/api/clans/social` exposes the detailed relations, decayed scores,
reasons and discipline stages on demand. Formal war state never follows directly
from these scores.

Validation: `test_clan_social.js` exercises independent attribution, witness/replay
deduplication, positive spam limits, decay, hot/cold parity, transactional failure,
warning/probation across SQLite reopen, fenced/stale expulsion rejection, durable
removal and readmission guards. Existing clan, interaction-memory, cold-worker,
party, native-combat and PvP handoff suites cover integration regressions.
