# Interaction memory foundation

This slice provides durable bounded memory, a shared decision view, and an
optional transactional cold-outcome event channel. Hot mob competition now emits
one directed memory episode per claim. It does **not** start new
conflicts, implement cold PvP, or replace
`partyHistory`, `pvpEnemies`, or player-to-bot `BotSocialMemory` yet.

## State and cost

Each rememberer has at most 32 character relations, 8 clan impressions and 8
alliance impressions. Relations are directed; membership is separate from
personal trust/hostility. Half the slots retain strong relations, the rest recent
ones. Scores decay with a seven-day half-life at read/update time, without timers.
This is an initial tuning policy, not an assertion about historical C4 rules.

Each durable snapshot includes up to 128 replay records and three recent reasons
per relation. A persisted timestamp watermark rejects old deliveries after their
deduplication records are evicted. New late events below that watermark are also
rejected explicitly. Equal timestamps at a full journal boundary can cause that
rejection: producers should submit episodes promptly, and treat `expired_event`
as a replan condition, not stamp a new time/key onto an old incident.

New events older than seven days or from the future are rejected. A retained
duplicate is acknowledged without changing memory. Reusing its key with changed
participants/type/time is an error. Keys are immutable episode identifiers, at
most 96 ASCII letters/digits/colon/underscore/dot/hyphen. Do not use a fresh UUID
on every retry. One hit callback is not one social episode.

Migration 37 adds `bot_interaction_memory`, one indexed snapshot per character,
deleted with the owning character. It is deliberately separate from lifecycle
`statsJson` so stale worker saves cannot overwrite recent interactions. The
existing generic `SocialGraphRepository` has an unbounded journal and relation
set; this bounded projection reuses the relation concepts without dual-writing
every incident into that unlimited history. There is one authoritative store
for this memory and the existing single SQLite writer remains the only writer.

In RAM and exported worker snapshots the replay ledger is omitted. Decision
reads perform three map lookups and bounded arithmetic; no SQL, LLM, graph walk
or population scan. Batches have at most 64 events and the runtime permits eight
pending batches. `memory_busy` requires the producer to retain/retry its batch.
Do not instantiate one repository-backed service per bot: use the runtime singleton.

## Hot/main API

```js
const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
await memory.load(characterId); // hydrate before relying on personal memory
await memory.recordBatch([{
    key: 'combat:encounter-123:victim-2000001',
    sourceId: 2000001, // remembers
    targetId: 2000002, // subject of memory
    type: 'attacked',
    at: acceptedAttackTime
}]);
const relation = memory.assess(
    { id: 2000001, clanId: 6000001, allianceId: 7000001, partyId: 'party-a' },
    { id: 2000002, clanId: 6000002, allianceId: 7000001 },
    { attackingMe: false, clanStance: 'neutral', allianceStance: 'neutral' }
);
```

The caller supplies current authoritative membership and diplomacy. This slice
does not invent alliances, infer clan-wide hostility from one member's actions,
or query actors from inside the evaluator. Membership changes affect the next
assessment without rewriting personal memory. `ready:false`/`unloaded` differs
from a loaded unknown relation. `outsider` does not mean `hostile`. Immediate
threat and membership can both be true. None of these fields grant permission to
attack: party duties, peace zones, flags, war rules and combat risk remain in
their respective policies.

Events are the rememberer's perspective. Producers may submit two directed
events together for an encounter, with different event types if appropriate.
Group impressions require explicit attributed evidence (`kind:'clan'` or
`kind:'alliance'`); no automatic propagation to all members occurs.

BotManager hydrates memory before publishing a hot actor. `ensureMany(ids)`
coalesces loads, skips cached owners, and reads at most 64 owners per SQL query,
yielding between pages. A decision never triggers hydration.

`BotMobCompetition.record` records an accepted competing attack against the
bot's actively targeted, claimed monster, independent of willingness to provoke
PvP. Party members, raids, arena participants and abandoned targets are excluded.
Clan membership does not erase personal grievances. Repeated swings/casts on
the same claim do not create additional episodes; respawn resets the claim.
Successful ordinary group hunts now create `hunted_together`. Hot episodes use
living, online, reward-eligible group members after NPC death; raids are excluded.
Cold worker episodes require wins, no losses and surviving participants, and
commit with the complete group's physical outcome. Resting/travel is not a hunt.
`lastHuntAt` in each retained relation enforces one positive hunt award per 30
minutes across hot/cold and restart; unrelated events cannot erase that clock.
The SQL reducer treats a cooldown rejection as an accepted no-op, so stale worker
views cannot inflate trust or abort legitimate physical outcomes. Large groups
send at most 64 directed events; remaining pairs stay eligible next resolve.
There is no automatic heal/help producer or cold competition producer yet.

Background party formation and recruitment use cached personal memory in both
directions. Among candidates of the same support priority and clan preference,
the mean bounded score (affinity + 2 * trust - 2 * hostility - fear) takes
precedence over legacy party-history counts. Unknown/unloaded memory is neutral;
no SQL is performed during selection. Negative scores are a preference, not a
veto. Role coverage, level eligibility and structural group scoring remain in
force. Each added recruit participates in scoring the next recruit; equally
suitable complete groups are compared by their mean pair score. A per-selection
cache evaluates each directed pair once at a fixed time. Formation explanations
include `memoryScore` and `positive_interactions` or `personal_conflict`.

Combat callbacks use `memory.events.enqueue(event)`. The queue holds at most
1,024 immutable episodes, writes outside the callback, and retains original keys
on transient failure. Full admission returns false; the mob claim retains its
episode for another callback. The queue is in RAM, so an abrupt crash can lose
uncommitted episodes. Graceful server shutdown drains it before closing SQLite
and reports remaining writes if its drain deadline is exhausted.

The Observer bot-detail API exposes `interactionMemory`: readiness, revision,
bounded relations with decayed scores, reasons and age. `memory.inspect(id)`
provides the same diagnostic view without SQL; `memory.events.snapshot()` exposes
queue depth and delivery counters. This does not add a new Observer UI panel.

## Cold integration contract

Create `new InteractionMemory()` without a repository in a worker. Feed
`accept(mainMemory.snapshot(id))`; call the same `assess` API. Older or equal
snapshot revisions cannot replace an already accepted view. Views are read-only:
they cannot be passed to the durable reducer, and workers cannot write SQL.
The coordinator hydrates full/incremental snapshot pages and explicit cold
handoffs. It includes the owner's compact memory in `context.interactionMemory`,
including commit ACKs. The kernel indexes that memory separately and removes the
transport copy from retained context. Social revisions are accepted independently
of lifecycle revisions, and stale pages cannot overwrite newer ACK memory.
Removing a worker entry releases its view; returning entries hydrate again.
Resolver callbacks receive `assessRelationship`, the same evaluator used on main.

`workerMemory.propose(events)` only validates/copies events. Put the result in
`proposal.result.memoryEvents`. Proposal compaction preserves this field. The
coordinator's existing owner commit path passes it to SQLite, where social and
physical state commit in the same transaction **after** lifecycle CAS validation.
Each proposal may only change the memory of its own `characterId`. A cold commit
transaction accepts at most 64 social events in total, across all participants.
For an
encounter affecting multiple characters use one complete `atomicGroup` containing
all participants, with their directed events in their respective proposals.
The single-owner `Owner.commit` path also accepts `options.memoryEvents`.

Rejected lifecycle proposals write no memory. Invalid/expired social events
throw and roll back the transaction, including physical changes. Main runtime
views receive successful cold snapshots through `ColdSimulationOwner.reflect`.
Worker ACKs distribute current social views through the existing byte-bounded
message paging. Successful hot episode delivery marks the owner's snapshot dirty.
Never record cold events separately
after a failed or merely proposed physical outcome. A multi-party PvP resolver
must validate all participants' ownership and political context before commit;
that resolver is outside this foundation.

## Validation

- `node tests/test_interaction_memory.js`
- `node tests/test_interaction_memory_delivery.js`
- `node tests/test_interaction_memory_persistence.js`
- `node --expose-gc scripts/benchmark-interaction-memory.js`

The benchmark constructs 2,000 full 48-relation views without server or SQL.
It reports heap growth after GC, serialized sizes and 100,000 assessments.
Numbers are local synthetic measurements, not live player-latency guarantees.
