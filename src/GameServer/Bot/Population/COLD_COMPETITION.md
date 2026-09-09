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
The model must be calibrated before using it to remove hunting opportunities.

At most 32 pressured target groups are sampled per scan with a rotating cursor.
Per-group encounter hazard is capped at 0.8/minute. There is no backlog catch-up.
Pair and participant cooldowns are ten and two minutes respectively. Expired keys
are removed; at most twelve recent forecasts are exported. Cooldowns and counters
are process-local observation state and reset with the worker. They are NOT the
durable deduplication needed for future gameplay events.

Decisions use both personal relationships and existing persona traits. An unknown
relationship is neutral; an unloaded memory view prevents evaluation. A stable
party representative stands in for each party, so this first estimator does not
model every member's opinion or clan/alliance diplomacy. Relative level and party
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
as `coldCompetitionActions` in the observer. Disputes, avoidance and PvP remain
forecasts. Two living solo hunters with the same active target can form a party.
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
