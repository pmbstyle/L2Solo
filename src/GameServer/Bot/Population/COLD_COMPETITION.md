# Cold resource competition: observation rollout

`coldCompetitionObserveEnabled` enables a read-only forecast in the cold worker.
The monitor does not reserve mobs, change rewards, send invitations, write relationships,
or initiate PvP. `offer_party.accepted` is a predicted response, not membership.
`contest` and `pvpIntent` are hypothetical decisions, not accepted gameplay facts.

The monitor runs after initial snapshots, at most once per 30 seconds, and skips
paused workers. It groups present, living cold hunters by spot and target NPC.
Travel/rest are excluded. Party members use their leader context's objective and
are one independent competitor; their occupied capacity still counts per member.
Untargeted hunters add proportional demand. Raid/non-monster targets are excluded.

Initial pressure is estimated using existing spot capacity multiplied by the
target's share of spawns, with a floor of one slot. This is not measured spawn
availability or kill throughput. Missing spawn data produces no estimate.
This pressure is an encounter trigger, not proof that a particular NPC was stolen.

At most 32 pressured target groups are sampled per scan with a rotating cursor.
Per-group encounter hazard is capped at 0.8/minute. There is no backlog catch-up.
Pair and participant cooldowns are ten and two minutes respectively. Expired keys
are removed; at most twelve recent forecasts are exported. Cooldowns and counters
are process-local observation state and reset with the worker. They are NOT the
durable deduplication needed for future gameplay events.

Decisions use both personal relationships and existing persona traits. An unknown
relationship is neutral; an unloaded memory view prevents evaluation. Each party
is one competitor; an actual instigator is sampled with assertiveness/ambition
weights and an actual counterpart is sampled uniformly. Observation cooldowns
follow party identity, regardless of which member speaks. The estimator does not
model clan/alliance diplomacy. Relative level and party
size provide a coarse strength signal. Role, goal and actual membership validation
must still happen before an eventual invitation can become a real party.

Worker heartbeat and `/observer/api/snapshot` (`coldCompetition`) expose pressure,
outcome counts, bounded examples, and scan duration. Do not interpret these counts
as actual conflicts. Before enabling effects, use durable episode identity,
participant ownership/CAS, inventory/reward accounting, and ordinary party APIs.
No negative memory may be produced merely from a forecast or shared objective.

## First real actions

`coldCompetitionActionsEnabled` lets the main process consume at most two fresh
yield/accepted-offer forecasts from a scan, with accepted offers taking priority
over yields; `budgetSkipped` counts excess
candidates. Capacity and clan-objective refusals have explicit result reasons.
Actual results are exported separately
as `coldCompetitionActions` in the observer. Avoidance and PvP remain forecasts.
Resource disputes can execute under the separate conflicts flag described below.
Two living solo hunters with the same active target can form a party.
An accepted offer between a solo hunter and an existing party can instead recruit
that hunter without consuming a new party slot. Party-to-party mergers and clan
equipment operations are excluded.

The action checks both lifecycle and memory revisions, target, presence, ownership,
hot-handoff fences and a durable two-minute participant cooldown. Old forecasts
expire after ten seconds. Main-process backlog/lag defers admission; there is no
catch-up queue. The forecast is consumed once per scan, including rejections.

A yield claims both participants and atomically records the episode with a
15-second delay for the actor. No relationship event is written. The resolver
deducts the idle interval once from subsequent farming time and clears the wait.
Party selection excludes pending waits. CAS validation rejects duplicate delivery
even after restart, and a stale participant aborts both writes.

An accepted offer uses the existing atomic party-membership transaction for both
solo hunters, with the episode marker in their persisted stats. Population limits
and the ordinary party creation path still apply. Only a successful membership
commit counts as a created party; shared-hunt memories still require later wins.

Recruitment validates the forecast party version, full roster, common target,
physical spot, capacity and ordinary composition rules. Every retained member
must be alive, cold, present and free of worker ownership or hot-handoff fences.
Unloaded memory or hostility between the recruit and any member rejects admission.
All members and the recruit commit atomically. Actual recruitment is counted under
`coldCompetitionActions.recruits`, separately from new parties.

Every new background party uses one shared safety ceiling (60 by default).
All creation paths reserve capacity through PartyAdmission while their SQLite
commit is in flight. Historical `capacityPool` metadata grants no privileges;
new parties do not write it. Existing parties are never evicted merely to make
room for queued candidates. Normal objective review and session expiry remain.

At capacity, an accepted solo-to-solo invitation atomically creates ordinary
preferred party requests for both hunters, preserving existing required requests.
They continue farming; this is no longer a replayable invitation. Later candidate
selection rechecks goals and composition, and may select different companions.
Current shared-target intent survives replanning only while the target matches;
ordinary request expiry/cooldown applies. `coldCompetitionActions.queued` counts
these deferred encounters, separately from actual formations.

Idle candidate groups rank by current need and capped waiting age, with existing
spot occupancy and compatible demand as tie-breakers. Clan origin grants no
priority by itself. Protected player-mode formation remains restricted to urgent
work. This shared count ceiling is a safety bound, not a measured CPU cost model;
the existing runtime lag/work budgets remain in force.

## Accepted resource disputes

`coldCompetitionConflictsEnabled` adds solo/party `contest` outcomes to the
existing maximum of two actions per scan. Accepted invitations rank first,
contests second, and voluntary yields last.
Main revalidates both active target plans, physical spot, target spawn presence,
memory revisions, cold ownership and hot-handoff fences. A forecast alone never
writes an offense.

An accepted contest interrupts the peer's hunting for fifteen seconds. The same
bounded wait accounting used by yielding prevents later catch-up farming for that
interval. This is a coarse cold resource interruption, not a live NPC kill or a
transfer of already awarded loot. The initiator receives no invented rewards.
The victim alone records `mob_contested` against the initiator, atomically with
both life states through the existing lease/CAS transaction. A rejected outcome
writes neither the interruption nor the memory. Accepted snapshots reach the
main memory cache and the cold worker through the normal state notification.

Both participants retain a ten-minute conflict cooldown in their life state;
ordinary cooperation preserves it, and restart cannot reset it. One encounter
adds three hostility points: a neutral victim becomes wary, not immediately
hostile. `pvpIntent` remains diagnostic; no attack, death, flag or karma change
is inferred. Observer `contests` counts committed interruptions separately from
forecast disputes, and recent results identify the victim and memory event.

Party encounters expand at most two complete rosters (18 bots). Every member must
be present, living, cold, ready for hunting and have loaded memory. The party
objective and roster version must still match the forecast. Individual members
support, stand aside or deescalate using their relationships and persona traits.
A calming leader or a strict calming majority settles the encounter peacefully.
Otherwise only involved members contribute to the coarse resource contest power;
the defender may hold ground and the initiator's side loses hunting time instead.

Party metadata, all member states and memory commit in the same lease/CAS
transaction. A losing party's shared next-resolve deadline moves by 15 seconds;
the resolver deducts the shared interval once, without catch-up rewards. Members
also retain the pause so leaving a party cannot erase it. Recovery is unaffected.
The direct target remembers actual aggressors; defending supporters remember the
instigator. Bystanders gain no negative relationship. Even 9v9 creates at most
17 memory events. The ten-minute conflict cooldown is durable on both parties and
their members. Peaceful settlements retain the cooldown but create no lost time
or negative memory, and are counted separately as `deescalated`. Recent outcomes
include matchup, individual roles and affected member IDs. No PvP is executed.

## Party lifetime

The legacy `sessionExpiresAt` is now the first review deadline, not a disband
deadline. Further reviews run every five minutes and persist a bounded decision
per member. Recent wins sustain a group; an urgent goal elsewhere, personal
hostility or repeated unsuccessful attempts with no progress can cause departure.
Commitment and friendship extend patience; committed friends can keep helping.
Goal/conflict concerns must persist through a grace period. Recovery and travel
suspend that grace without erasing it. Repeated failed fights can still exhaust
patience during recovery; elapsed recovery alone cannot. No negative memory is invented by review.

Large worker results use sparse JSON transport against the leased input state
when ordinary compaction exceeds the IPC limit. Main checks the lease identity
before reconstruction; the complete party retains its existing atomic CAS commit.
Observer `partyReviews` reports committed worker reviews, departures (including
minimum-size releases), dissolutions and decision reasons since process start,
with the last twelve reviews retained. These counters do not depend on eviction
from the per-bot life-event history.

Only departing members leave. An attached leader remains, otherwise a replacement
is elected; fewer than two remaining members dissolves the group. The main runtime
commits the full review transaction with party/membership version checks. The cold
worker uses its existing complete-party atomic transition. Review itself awards
no farming time or rewards. Successful groups have no fixed maximum lifetime.

Validation: `node tests/test_cold_competition.js`, worker isolation/coordinator
tests, then observe actual server target groups and scheduler latency.

## Reproducible repeat encounters

`node tests/test_cold_competition_reencounter.js --report` compares the actual
decision policy on 20,000 fixed seeds in each direction. Its checked-in fixture
contains two accepted simulation-2 episodes (solo and 5v5), projected identities,
levels, persona seeds and relationships read from SQLite. Running the test uses
only that fixture; SQL access is forbidden. It never changes a running world.

The neutral control removes only the episode's directed grievances, preserving
other relationships. The one-offense variant uses saved relationships. Seven
additional synthetic episodes, spaced beyond the ten-minute conflict cooldown,
produce the eight-offense variant through InteractionMemoryPolicy.apply. All
variants use the same evaluation time, participants, levels, pressure (3), and
random seeds. This isolates memory effects; it is not an exact historical replay
or an estimate of encounter frequency on a live server.

Assertions cover changes in competition, avoidance, accepted invitations and
ordinary recruitment scores, actual cold-monitor decisions, and supporter versus
bystander reactions. Main-runtime assessments must equal assessments after memory
serialization and ColdSimulationKernel.upsert. This parity covers relationship
assessment and escalation intent, not identical hot/cold combat execution.
Neither the test nor its reported PvP intentions
executes a fight. Saved evidence and memory must remain unchanged by decisions.

## Hot resource-dispute responses

`Social/ResourceCompetitionPolicy.escalationChance` is shared by cold dispute
forecasts and hot `BotMobCompetition` reactions. It reads the responder's existing
personal memory and persona: hostility increases intent, while warmth, fear,
caution, resilience and empathy reduce it. Intent is capped at 20%; unloaded
memory produces no attack intent. The hot callback reads only the memory cache,
without loading SQL. Reencounter tests compare both modes on identical memory,
persona and RNG, including probability boundaries.

Hot callbacks observe accepted competing swings/casts on a claimed mob, rather
than forecasting a possible resource shortage. They still write one factual
episode per mob claim and use the existing warning/cooldown flow. A shared intent
does not bypass live risk, party/clan protection, peace/arena rules, active combat
or effect restrictions. Actual PvP continues through Revenge and the ordinary
combat loop. This change aligns escalation; it does not add hot social invitations
or replace actual combat with a cold simulated outcome.

## Shared conflict participation

`Social/ConflictParticipationPolicy` selects individual roles for both cold
resource contests and autonomous hot party provocations. The same cached memory,
personas and RNG produce the same roles for an identical eligible roster, in
character-ID order. At most two nine-member parties participate. Unloaded memory
and unavailable hot members cannot grant support. A calming leader or strict
majority can stop the planned escalation. Voting itself creates no grievance.

Hot `BotConflictParticipation` saves one bounded decision per encounter. Revenge
checks the nearby roster and leadership again before sending a pending warning,
during AI selection and at native impact before the first hostile action.
Changed rosters permanently revoke that episode's permission, without rerolling
or reviving it when the old roster returns. Only available consenting members receive proactive combat
permission after that action; new members cannot inherit it and departing
supporters lose it. The final pre-attack risk check excludes bystanders and busy
supporters from allied strength.

An actual incoming attack still follows existing party defense. Human-led bot
companions retain their existing coordination. These are participation decisions,
not simulated damage: hot combat and its existing factual memory producers remain
responsible for what actually happens. Actual cold PvP resolution and transfer of
an ongoing fight between hot and cold modes remain separate follow-up work.

## Native PvP memory

Accepted hostile actions, damage and deaths feed `Social/PvpInteractionMemory`
through `BotEnemyMemory`. The victim remembers the attacker personally: repeated
hits are coalesced into one `attacked` episode per minute, while death adds a
separate `killed` episode. Arena fights and existing native protection exclusions
remain outside this path. Summon attacks retain their owner's identity.

The existing bounded event queue persists these episodes outside combat callbacks
and notifies the cold worker. Stable event keys make delivery retries idempotent;
queue pressure retains the original key for a later callback. Personal relations
remain available after cooling or restart, independently of the three-entry
revenge shortlist. This does not change revenge thresholds or spread an individual
grievance to a clan or alliance.

Validation: `test_pvp_interaction_memory.js` covers hit coalescing, death, replay,
queue pressure, shortlist overflow and SQLite reopen. `test_bot_pvp_defense.js`
checks attack and death episodes through native `ReceivedHit`.

## Whole-party visibility lifecycle

Near-player activation treats each autonomous background party as one unit (2–9
members). A full party can consume an otherwise empty activation pass even when
the solo budget is smaller. All members must have safe placements near their
leader and pass the floor check. The cold worker is fenced before a transaction
reserves the whole roster as hot. Actors load privately; only a fully prepared,
persisted roster is published and starts AI. Spawn failure rolls the group back.
The party's identity, leader, roles, objective and social memories remain intact.

Hot background parties regroup, share a hunting target and recovery, and use
native party EXP/SP and loot distribution. Hot solo and party drops appear on
the ground; the nearest eligible bot runs to collect them through native pickup.
Only after arrival does pickup split Adena across the eligible roster or select
an item recipient by the party policy. A party waits for its collector before a
fresh pull, while incoming combat, revival and support casts retain priority.
Party spells see the full roster, and visible or fighting members keep their
allies' AI active. They retain distinct identities from
human-led companions. Observer exposes the durable party ID for hot members.

Safe hot parties use native healing, resurrection and learned party buffs before
resuming their hunt. Autonomous resurrection requires a learned skill or a real
scroll; fallen members wait for rescue while it remains possible. Hot/cold effect
handoff restores the saved effects with their original expiration times, so
activation does not renew existing buffs or require a full rebuff.

When the 1800-unit combat scan is empty, the leader searches up to 4500 units
within the same spot, at most once per five seconds. It walks toward a reachable
live monster or known spawn point; native movement and the normal combat scan
take over en route. Each search checks at most eight destination surfaces, avoids raids
and other floors, and does not replace pending movement. Native pathfinding checks
the route; recent destinations have a retry cooldown. Followers regroup;
the leader waits for stragglers. Recovery and actual combat take priority.

Cooling requires every member to be away from players, beyond the grace period
and free of combat/trade obligations. All live snapshots commit together before
actors are removed and worker snapshots are notified. Cold time resumes at the
transition, so time already played hot is never awarded again. Startup recovers
hot reservations to cold groups without dissolving membership.

Validation: `test_hot_party_lifecycle.js` covers full-roster publication, failed
spawn rollback, duplicate requests, stale worker leases, 9-member CAS, memory,
visibility/PvP guards, SQLite reopen and recovery in a fresh process.
`test_hot_background_party.js` exercises target sharing, support priority,
regrouping under attack, native death rewards, shared-hunt memory and Adena
distribution. `test_bot_population_policy.js` checks whole-party activation
when the per-pass solo budget is smaller than the roster. Live activation must
additionally prove that the native actors publish with the same roster and
that the cold worker resumes after the full group leaves the world.
