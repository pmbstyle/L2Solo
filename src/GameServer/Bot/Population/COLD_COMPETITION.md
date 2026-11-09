# Resource competition in cold and hot simulation

## Configurable PvP aggression

Set `[BotPopulation] pvpAggression` in `config/local.ini` and restart the server.
The accepted range is 0..1; `BOT_PVP_AGGRESSION` overrides the INI value.
Missing or invalid numeric values use 0.5; finite out-of-range values are clamped.
0.5 preserves the existing balance. Below the midpoint, escalation/revenge
chances scale toward zero (0.25 halves them). Above it, nonzero chances interpolate
toward 100% (0.75 closes half the remaining gap; 1 guarantees eligible escalation).
Zero chances remain zero, including fully restrained responses to friends.
0 prevents autonomous PvP initiation, including revenge and unprovoked PK pursuit.
Resource disputes and their memory still occur. This level is not a probability
of attacking every encountered bot: cooperation, dispute selection and combat
admission still apply before a fight can start.

The setting also influences retreat: low aggression increases the required
strength advantage, avoidance probability and HP withdrawal threshold; high
aggression accepts more risk. Personality, fear, friendship, clan discipline,
combat legality and cooldowns remain in force. Self-defense and aid to attacked
party members remain available, but bots can decide to flee. Existing fights
are not erased when the setting changes. Hot and cold combat use the same
modifiers with their respective existing risk heuristics.

This is not a target number of fights per hour: pressure, opponents, parties,
relationships and retreat still determine actual outcomes. The main process
sends its resolved value to the cold worker; decisions add no database queries,
timers or additional population scans.

## Hot decisions before a competing attack

`HotResourceCompetition` runs at the autonomous bot combat entrypoint, before
the first hostile action on a mob claimed by another autonomous bot. A claim
still requires a real accepted swing/cast; selecting a target never owns it.
The shared `ResourceCompetitionPolicy` reads both relationships and personas.
Hot pressure uses the two hunting units and the nearby living NPCs of the same
type. It is a local contention estimate, not a server-wide spawn reservation.

Coexist releases the contested target and promptly looks for another. Yield
pauses the whole initiating unit for 15 seconds. Avoid requests native movement
along safe retreat plans and excludes the rival's local hunting area for two
minutes; unsafe routes fall back to yielding. Cold avoidance chooses another
abstract spot, while visible hot actors walk away locally. These are tactical
hot-session commands, not new grievance events. Incoming NPC/PvP combat takes
priority, including attacks on another member. No accepted cast is cancelled
to negotiate, and human-led companion parties keep their existing behavior.

An accepted offer creates or recruits into a persistent `hot` background party
through the ordinary membership transaction, without actor respawns or attaching
player companions. Both cold and hot formations use the same admission budget.
Before committing, the transaction rechecks live consent, roster, phase, memory
versions, clan reservations and existing-party version. Cooldown/player admission
cannot interrupt an in-flight membership change. The full roster is published
synchronously after commit and uses normal hot combat, loot and cold lifecycle.
Party mergers and recruitment into clan objectives are excluded. Merely joining
does not award shared-hunting memory; actual later hunting still supplies it.

Only an accepted competing attack writes `mob_contested`; a contest forecast
does not. Existing victim provocation, risk and PvP permission checks remain in
force. Decisions are bounded by a two-minute unit cooldown. No claim means a
constant-time return, and there is no population polling timer or SQL decision
read. `/observer/api/world/status` exposes `hotCompetitionActions` separately
from cold forecasts and actions; recent results distinguish executed outcomes
and failed invitations.

## The spot aggregate: who holds a spot (worker)

Cold competition and cold revenge are situations of a spot, decided once when a unit
arrives there; there is no periodic scan, no pair or unit cooldown and no revenge or
conflict window. A pair meets again only at a later arrival.

`SpotContest` (pure) meets the arriving unit (a solo bot; a party through its leader
until the party aggregate) with the units standing on the spot, read from the worker's
occupancy index (bots on their way do not stand there; an arrival whose commit is not
acked yet does, and the units it displaces do not). Over room is per-target pressure:
the hunters on the arriving unit's target species, the untargeted by spawn share,
against that species' share of the spot's room (`LevelingRoutes.capacityForSpot` times
the spawn share, at least one place). Over room the arriving unit compares itself with
each standing unit by what a player sees (`VisibleStrength`: weapon grade and glow, body
armour grade, people with servitors; no level):

1. a stranger that looks stronger stands there: the arriving unit answers the strongest
   one: it leaves (`outmatched`), shares (`tolerated`) or disputes it (`pvp`);
2. else it asks the weakest strangers it looks stronger than, each by its can-I-win roll,
   to make room until the species is back to its room (at most eight units; standing
   parties are not asked); each answers at the pressure then: it leaves (displaced),
   shares (`spot:contest:tolerated_standing`) or disputes (one per arrival). The arrival
   stays (`stronger`, or `pvp` with a dispute) when it displaced at least its own hunters,
   the pressure after is within its own tolerance, or one stood its ground and the
   pressure after is under twice the room; else it leaves (`outmatched`);
3. else (an even look) a clanmate or friend there lets it share under twice the room
   (`friendly_share`); otherwise it answers the first met stranger: it shares (`shared`),
   disputes (`pvp`) or leaves (`even`, or `crowded` at twice the room): the first come
   holds it.

The answer of the unit that does not hold the spot by look is its persona's
(`ResourceCompetitionPolicy.decide` with it as the actor): avoid is leaving; a party
offer (no party forms at the spot), a yield or a contest without PvP is sharing while the
pressure is within its tolerance (`ResourceCompetitionPolicy.tolerance`: 1 to 1.3 times
the room, by sociability, empathy and the lack of ambition), else leaving
(`spot:contest:past_tolerance`); a contest with PvP intent, PvP on, is a dispute main
carries out, the disputing unit its actor. A sharer takes the crowd's equal share; the
stay judge (`spot_disappoints`) sends it away when that earns too far below its
expectation. C4 has no bot rule here: a polite weaker player moves on, a stubborn one
stays for the leftovers or fights (KS etiquette, karma); the numbers are our choice.

Relationships are read for at most four met units and eight displacement candidates; an
unread unit counts as a stranger, so a capped read only makes the arrival leave. A unit
on a player's command or a safety evacuation never leaves (counted). Bodies near a player
standing there are neither met nor displaced (their own tactics, below). Ordinary hunters
with no active equipment target use a stable representative NPC drawn from
level-appropriate spawns weighted by count (`PartyHuntingTarget.competitionNpcId`); this
is competition context only, not the PvE target.

The arriving unit's own outcome rides its arrival step: leaving raises `contest_lost`
with the spot as its mark (it wakes the earning spot; the mark lasts the outing). A
party's leave is a mark on the party (`PartySpotRiskPolicy.withMark`): its next step
hears `contest_lost` on its held spot and its spot decision (`party_spot`) moves it. A
displaced bot hears `contest_lost` (reason `displaced`) at its next step once the
arriving commit is acked (the kernel's step wake: no commit of its own, it finishes the
window its step already credited); a near arrival displaces at once. The unit that lost
remembers the stronger one (`mob_contested`, `SpotContest.grievance`, counted
`spot:contest:grievance`), written by its own commit: a displaced far bot at that next
step, a far solo arrival that shares under a stronger stranger (`tolerated`) at its
arrival step. Parties and standing units that chose to share write none; bodies near a
player write theirs per mob (`BotMobCompetition`).

The spot keeps its reputation (`SpotRecords`, worker only): after five arrivals over its
room it is held (the holder's best look and largest unit), until an arrival finds it at
0.8 of its room or less. A bot hears of a hold at its town arrival; once heard, its solo
spot search skips the camp when it looks weaker than the holder, has fewer people, or
looks even and is more cautious than assertive (`spot:repelled`). A clearing is known at
once; the bot's own sight is its outing mark.

`EnemyMet` (pure, both threads) meets the arriving bots with the standing ones, both
ways, where the holder remembers the peer or their clans are in a mutual war; the shared
`RevengePolicy` decides (karma-aware: a red bot starts no fight outside a war, a red
target is free, a white one weighs flag and karma), rolled once per (holder, peer,
arrival step). Two far bots fight through main (below); two bodies near a player reach
main as a `spot_command` (`BotRevenge.fromSpot`, the worker's roll, main checks the body
and the 900-unit notice radius); a far and a near bot are only counted (`enemy_met:mixed`).
A player's client first receiving a bot's CharInfo is a meeting too
(`BotRevenge.playerSeen`, rolled per bot, player and the bot's stay).

Outcomes touching other bots (the units an arrival displaces, a PvP dispute; a far
`revenge` or `clan_war` meeting) wait in `SpotContestOutbox` for the arriving step's own
commit ack; disputes and meetings are then fenced with that bot's committed revisions and
go in the competition frame of the next heartbeat; the frame's receipt frees it. A
refused ack, another step's ack, the bot leaving the far simulation, the worker's stop or
an age past 10 s from the arrival drops them, counted (`spot:contest:<why>` on the
situations= line), never re-fenced. Counters: `spot:arrival:checked/over`,
`spot:contest:outmatched/even/crowded/stronger/friendly_share/tolerated/shared/pvp`,
`spot:contest:tolerated_standing/past_tolerance/grievance`,
`spot:contest:displaced/displaced_left`, `spot:contest:capped/memory/commanded/evacuation/hot_peer/hot_skipped`,
`enemy_met:<reason>`, `enemy_met:mixed`, and main's `enemy_met:<outcome>`.

## First real actions

`coldCompetitionActionsEnabled` lets the main process apply at most four fresh
PvP-dispute/revenge/clan-war outcomes (eight attempts) from a frame, PvP first, within
one 75 ms wall-time budget; `budgetSkipped` counts excess candidates, which are not
carried out (the worker counts them, `spot:contest:skipped`). Actual results are
exported separately as `coldCompetitionActions` in the observer. PvP requires its
separate enable flag; the worker hears the combined flag at start and sends no PvP
dispute without it. The action checks both lifecycle and memory revisions, target,
presence, ownership and hot-handoff fences. Outcomes expire ten seconds after their
arrival. Main-process backlog/lag defers admission; there is no catch-up queue. A
frame is consumed once, including rejections.

Every new background party uses one shared safety ceiling (60 by default).
All creation paths reserve capacity through PartyAdmission while their SQLite
commit is in flight. Historical `capacityPool` metadata grants no privileges;
new parties do not write it. Existing parties are never evicted merely to make
room for queued candidates. Normal objective review and session expiry remain.

Idle candidate groups rank by current need and capped waiting age, with existing
spot occupancy and compatible demand as tie-breakers. Clan origin grants no
priority by itself. Protected player-mode formation remains restricted to urgent
work. This shared count ceiling is a safety bound, not a measured CPU cost model;
the existing runtime lag/work budgets remain in force.

## Accepted resource disputes

`coldCompetitionConflictsEnabled` lets a frame's `contest` outcomes (a PvP dispute,
or a dispute with a party on a side) run through the party conflict below. Main
revalidates both active target plans, physical spot, target spawn presence, memory
revisions, cold ownership and hot-handoff fences. A forecast alone never writes an
offense. No conflict window follows: the pair meets again only at a later arrival.

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
17 memory events. Peaceful settlements create no lost time
or negative memory, and are counted separately as `deescalated`. Recent outcomes
include matchup, individual roles and affected member IDs. No PvP is executed.

## Party lifetime

A party's first resolve records its review evidence (no review step). A review
runs when its inputs move (roster and levels, objective, members' plan targets
and clan objectives, relation revisions) or a clock runs out (a concern's grace,
patience with no win, recent progress ending, a pause ending), never on a fixed
cadence, and persists a bounded decision per member. Recent wins sustain a group; an urgent goal elsewhere, personal
hostility or repeated unsuccessful attempts with no progress can cause departure.
Commitment and friendship extend patience; committed friends can keep helping.
Goal/conflict concerns must persist through a grace period. Recovery and travel
suspend that grace without erasing it. Repeated failed fights can still exhaust
patience during recovery; elapsed recovery alone cannot. No negative memory is invented by review.

Group wins do not prove that every member earns experience. A member excluded
by C4 party reward eligibility leaves with `party_no_experience` after at least
three newly observed wins and their persona-dependent patience window. Rest
alone cannot trigger this decision, and renewed eligibility clears its evidence.
Formation and recruitment also reject compositions that exclude a participant
from experience, including recruitment that would exclude an existing member.

Large worker results use sparse JSON transport against the leased input state
when ordinary compaction exceeds the IPC limit. Main checks the lease identity
before reconstruction; the complete party retains its existing atomic CAS commit.
A member's leave is its own decision (`party_stay`), counted with the other
decisions on the worker's situations line and traced with its answer.

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
additional synthetic episodes, spaced ten minutes apart,
produce the eight-offense variant through InteractionMemoryPolicy.apply. All
variants use the same evaluation time, participants, levels, pressure (3), and
random seeds. This isolates memory effects; it is not an exact historical replay
or an estimate of encounter frequency on a live server.

Assertions cover changes in competition, avoidance, accepted invitations and
ordinary recruitment scores, actual arrival contests (SpotContest), and supporter versus
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
responsible for what actually happens. Bounded cold PvP resolution is described
below. Transfer of an ongoing fight between hot and cold modes remains separate
follow-up work.

## Bounded cold PvP

`coldCompetitionPvpEnabled` consumes accepted contest episodes whose existing
forecast includes `pvpIntent`. It shares the same four-success/eight-attempt fight budget,
roster votes, memory revisions and ownership fences.
No new encounter generator or backlog replay is introduced. Peace zones and
same-clan opponents cannot grant attack permission; a materially outmatched
responder declines escalation. Clan membership and karma are rechecked against
character rows inside the commit transaction.

The responder to the resource intrusion starts the skirmish. At most 18 fighters
execute 256 coarse actions within a 30-second simulated window. Profiles include
current equipment, active buffs, HP, MP and CP. Existing physical/magic formulas,
learned offensive skills, healing, reuse deadlines and persona-based retreat
drive the result. Skill selection and damage use episode-seeded randomness.
The first casualty ends the skirmish; otherwise retreat or the work/time cap ends
it. This is a bounded approximation, not full native pathfinding, projectile,
control, summon or consumable simulation.

Only actual attackers produce `attacked` episodes; the casualty also remembers
`killed`. Resource grievances retain their existing directed attribution. A
completed attack on an opponent without karma flags the attacker for this
simulated encounter; the kill's PvP/PK/karma outcome is the C4 rule shared with
hot (`PvpRules.killOutcome`, applied at the commit by `PvpRules.tallyAfterKill`). Character
counters and native karma awards, life-state health/resources, death, cooldowns,
party deadlines and memory commit atomically. No XP or ground loot is invented.
Death clears buffs, charges and the summon; a 90-second recovery delay precedes
the existing cold recovery flow. Parties wait for their fallen members.

Production encounters advance in bounded one-second steps. Each participant
retains the encounter ID, full roster, original participation votes, deadline,
next action time and delivered incident IDs. The worker defers ordinary farming
and lifecycle planning while the main encounter owner advances combat; there is
no catch-up damage or farming burst after a stall. The complete resolver remains
available for deterministic offline tests.

The initial live encounter deadline is 30 seconds. A newly resolved cold attack
in the final five seconds can extend an ongoing fight by 15 seconds, at most
twice, with a hard deadline 60 seconds after the original start. The total cold
action budget remains 256. Idle/heal-only steps, retreat, death and expired
encounters do not extend it. Hot/cold transitions preserve the current deadline
and spent cold actions rather than granting fresh budgets. Extension does not
create another aggression episode. Observer `coldCompetitionActions` exposes
`pvpExtensions` and `pvpExtendedMs` for committed grants; two extensions can
belong to the same fight.

Visibility transfers the entire conflict, including both parties and bystanders,
in one lifecycle transaction. Actors load privately without ready-spawn refills.
Only after every member is prepared are they published and given their original
opponents. HP/MP/CP, skill reuse, effect deadlines and the remaining PvP flag are
preserved. Receiving an attack does not flag a white victim; accepted hostile
actions against non-chaotic targets do. The first visible CharInfo has the
restored flag. Karma still controls red names.

Once all participants are beyond player visibility and the cooldown radius,
cooling drains existing attacks/casts before capturing the whole roster. New
auto-attacks are held during this drain; a player/NPC intervention or resource
change aborts the transition. Cold time starts at the handoff, never at the last
cold tick. Original episode keys deduplicate social memory across transitions.
The ordinary two-minute visibility grace does not pin an active encounter hot.
After materialization, cold continuation checks the opponents' actual distance
and protected context instead of requiring the original resource spot or target.
Death, retreat, expiry or invalid membership ends the encounter. Spawn failures
roll back the full hidden roster. Restart reloads unfinished cold encounters;
expired ones end without catch-up attacks.

This lifecycle currently applies to encounters started by the cold resource
resolver. A fight that first starts between already-hot actors still uses native
combat and its existing cooldown guards; it does not create this shared encounter.

Observer `coldCompetitionActions` reports `pvpFights`, `pvpDeaths`, `pkKills` and
bounded recent results with participants, actions, HP/MP/CP and individual kills.
These are committed outcomes, distinct from the arrivals' PvP intents.
`test_cold_pvp.js` checks deterministic 1v1 and 9v9 resolution, healing, resource
loss, PK/PvP, recovery, protection, ownership/context races, complete rollback,
duplicate delivery and SQLite close/reopen.
`test_pvp_encounter_handoff.js` checks stepped party combat, complete publication,
cold/hot/cold resources and flags, memory deduplication, expiry, rollback and
SQLite reopen. `test_bot_effect_handoff.js` checks native EnterWorld flag and
skill-reuse restoration in addition to effect expiry.

## Native PvP memory

Accepted hostile actions, damage and deaths feed `Social/PvpInteractionMemory`
through `BotEnemyMemory`. The victim remembers the attacker personally: repeated
hits are coalesced into one `attacked` episode per minute, while death adds a
separate `killed` episode. Arena fights and existing native protection exclusions
remain outside this path. Summon attacks retain their owner's identity.

The existing bounded event queue persists these episodes outside combat callbacks
and notifies the cold worker. Stable event keys make delivery retries idempotent;
queue pressure retains the original key for a later callback. Personal relations
remain available after cooling or restart, independently of the old three-entry
enemy history. That history is retained for diagnostics, not revenge decisions.

## Revenge and clan war meetings

`Social/RevengePolicy` evaluates the same cached relationship in hot and cold
mode. A personal grievance needs personal hostility of at least 12 and trust at
most -5, effective hostility 24, effective trust at most -5 and no positive
affinity; a mutual clan war is a grievance of its own. Clan reputation modulates a
personal grievance but cannot create a campaign against unknown clan members.
Same-party/clan affiliations remain protected. Fear, empathy, caution, resilience
and clan discipline reduce the chance; assertiveness and resentment increase it;
the C4 standing weighs it (`PvpAggression.karmaCost`). The chance is capped at 35%.
These are intent thresholds, not PvP or clan-war permissions.

The meeting itself is `enemy_met` at an arrival (above), or a player's first sight of
a bot; nothing scans for enemies. A queued warning retains the meeting's roll;
changed relations can cancel it before the first hostile action (`BotPvpDefense`
flushes it). Human-led companions do not initiate. A war fight's allies are the
initiator's party members at mutual war with the target, joining at the first blow.

Far meetings reach main as `revenge` / `clan_war` outcomes; main rechecks current
memory and the roll against the rule's chance, positions on the meeting's spot, full
party rosters, ownership and physical combat permissions; rejection writes no
incident. Accepted fights use ordinary participation votes (a war: its war roles) and
the atomic PvP transaction. `revenge` encounters preserve their cause through hot/cold
transitions; the avenger is accountable for fresh aggression, its target's response
is defense. No `mob_contested` event is invented.

Validation: `test_revenge_policy` (the rule and `EnemyMet`), `test_bot_revenge`,
`test_clan_war_native`, `test_cold_pvp`, `test_revenge_handoff` and
`test_bot_enemy_memory_persistence`.

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

Meaningful combat healing also creates `aided_opponent` for the recipient's
last directly damaged, living bot opponent, when that damage is less than 15
seconds old. Native resurrection uses the same recent-victim evidence. This is
not a roster-wide grievance: bystanders, old enemies, ambient healing and
self-healing do not qualify. Native observations require the victim within
1800 units; cold observations require an actual opposing fighter. Each retained
personal relation permits one such grievance per helper per 30 minutes, using
a durable `lastAidAt` clock shared by hot/cold decisions and SQL admission.
The trace tracks the latest HP-damage victim only; it does not scan population
relationships. Cold healing commits the fact atomically with its combat result.
Clan evidence follows the known side's responsibility: aggression/provocation
can count, while defense and unknown responsibility cannot assign clan guilt.
This adds no war permission. Defeating a threat does not itself accuse its rescuer.

Native hostile actions also retain responsibility for ordinary player/bot fights.
The first accepted action establishes the initiator for that opponent; return
attacks retain self-defense, including nearby party members defending the actual
victim. Witnesses receive no invented offense and the attacker's party does not
inherit guilt. Flags, karma and an unrelated revenge/defense objective do not
establish responsibility. Known managed encounters keep their existing sides.
The same evidence attributes meaningful aid to a combat opponent.
Each hot session holds at most 32 opponent records, expiring after 60 seconds
without activity. New facts share the existing serialized enemy-memory write;
ordinary repeated hits only refresh RAM. Bot lifecycle snapshots preserve these
records across hot/cold handoff; expired records do not resume an old incident.
There is no new cold combat pass, relationship scan or independent SQL writer.

The cold worker can resurrect a party casualty with a nearby living member's
learned single-target resurrection skill. One aggregate outcome commits the MP
cost, reuse deadline, 1 HP revival and gratitude together. The party then uses
its ordinary recovery schedule for a 15-second pause. There is no pending cast,
cast-speed calculation or separate completion/cancellation pass. The outcome
requires the whole roster even if memory is unloaded or gratitude is on cooldown;
hot activation racing the commit is rejected by the existing ownership checks.
Active PvP and travel exclude a rescue. Without an eligible caster, ordinary death recovery remains
the fallback and grants no gratitude. Resurrection does not restore EXP, buffs,
CP or full vitals. Mass resurrection and cold scroll consumption are not modeled.
The legacy sequential resolver keeps ordinary recovery; paid resurrection uses
the worker's atomic commit path. Party review and new travel wait for casualties.

Native resurrection records gratitude when the death flag is actually cleared,
not when the cast is merely accepted. Native HoT ticks accumulate actual healing
while an injured recipient is in combat. A total of 5% max HP qualifies through
the existing shared help cooldown. The effect stores its caster identity,
partial credit and remaining ticks so restored effects retain attribution without
renewing the tick count. Ambient regeneration and self-healing grant no credit.
Cold combat does not yet execute the periodic HoT effect ticks.

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
