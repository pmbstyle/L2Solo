# Runtime Performance Architecture

## Scope and operating assumption

Production is one game-server process. The main server plus three simulation
instances are a test topology, not the target deployment topology. Four-process
measurements are useful for exposing contention and correctness bugs, but host
CPU and storage contention must not be interpreted as the capacity of one
production server.

The target is player-first simulation: background progress may slow down, but
player-facing latency and durable queue correctness must not degrade when a real
player connects.

## Current execution topology

| Boundary | Owns | May access SQLite directly | Notes |
| --- | --- | --- | --- |
| Main event loop | sessions, hot actors, packets, population maintenance admission | yes | latency-critical and currently owns many independent timers |
| Cold simulation worker | cold-state compute and proposals | no authoritative writes | correct place for CPU-only simulation work |
| Cold commit queue | ordered proposal commits | yes, through the main database queue | must remain bounded because SQLite has one writer |
| Checkpoint worker | WAL checkpoint work | isolated connection | maintenance only; guarded by player/idle policy |
| Pathfinding workers | expensive path search | no | good worker boundary because results are pure proposals |

Adding workers is not a general solution. CPU-only, snapshot-based work can move
to workers. Authoritative mutations, session state, and ordered SQLite commits
must stay fenced and serialized.

## Confirmed findings

### 1. Background admission is fragmented

`PopulationService` owns more than a dozen independent intervals. The cold
coordinator, director, metrics monitor, and commit queue add their own loops.
Each job has local running guards and some have local player/lag checks, but
there is no process-wide background budget.

This means individually valid passes can overlap. For example, the configured
player budgets allow goal metadata, party formation, clan work, cold commits,
and maintenance to be admitted independently. Their combined cost is not
bounded by any single player-facing SLO.

### 2. A budget is cooperative admission, not preemption

A deadline can prevent the next unit from starting. It cannot interrupt one
synchronous calculation, one SQLite statement, or one already-started action.
Every queue therefore needs all three controls:

1. claim only the unit currently admitted;
2. measure each non-preemptible stage;
3. size or split that stage so its p95 fits the lane budget.

Increasing a batch size or a deadline without those controls only increases the
size of an uninterruptible burst.

### 3. Timer phases collide

Several 5 s, 10 s, 30 s, and 60 s intervals are installed during the same
startup phase. Their common multiples repeatedly align summary generation,
migrations, market maintenance, goal reconciliation, party cleanup, clan work,
lease maintenance, and checkpoints.

Running guards prevent duplicate instances of the same job. They do not prevent
different jobs from competing for the event loop and the database queue.

### 4. SQLite is a serialized authority boundary

More JavaScript workers do not create more SQLite write capacity. The scalable
pattern is:

- indexed, bounded reads;
- immutable worker snapshots;
- CPU work in workers;
- compact proposals;
- ordered, fenced, idempotent commits;
- backpressure before claims, not after them.

The clan founder scan demonstrated the query side of this rule. Its original
plan filtered the population and built a temporary sort tree. The composite
`characters(clanId, level DESC, id ASC)` index changed the same query from an
83-115 ms test-host range to roughly 1-3 ms and removed the temporary sort.

### 5. Player policy is inconsistent between jobs

Some maintenance stops completely for a protected player, some uses a smaller
batch, and some only checks event-loop lag. Local policies are valuable, but
without a shared governor the sum can still violate the player budget.

### 6. Observability must follow work through its lifecycle

Queue depth alone is insufficient. Durable work needs `claimed -> resolved ->
released -> leftRunning`, lease recovery, queue age, and attempt metrics.
Expensive passes need bounded rolling stage distributions, not only total
average/max values.

## Target scheduling model

Introduce one process-local `BackgroundWorkGovernor` on the main event loop.
It should admit work; it should not execute domain logic itself.

### Lanes

| Lane | Examples | Policy |
| --- | --- | --- |
| P0 player critical | packets, session state, hot actor decisions | never waits behind background work |
| P1 authoritative commit | cold proposals, inventory/party/clan settlement | short, ordered, fenced; strict queue cap |
| P2 near-player lifecycle | activation, cooldown, party support | player-aware and distance/event driven |
| P3 simulation | cold snapshots, clan actions, founder scan, party formation | token budget; defer on lag or DB pressure |
| P4 maintenance | migrations, retention, cleanup, WAL reset | idle-only unless correctness requires it |

### Admission inputs

Every background admission should use the same snapshot:

- real/connecting player state plus protection grace period;
- event-loop lag and utilization;
- database queue depth and oldest wait;
- cold commit queue depth;
- current lane in-flight work;
- recent p95 of the requested stage;
- durable queue age, so starvation can raise priority without bypassing safety.

### Required governor behavior

- A rolling token budget per lane and player mode.
- At most one SQLite-heavy P3/P4 pass admitted at a time.
- Deterministic phase offsets plus small stable jitter for periodic jobs.
- No pre-claim beyond admitted concurrency.
- Explicit deferral reasons and wait-time metrics.
- Starvation aging with a hard cap; old work gets priority, not an unlimited
  batch.
- A job whose minimum stage p95 is larger than its budget is marked
  `unsplittable`, measured, and routed to an optimization/splitting backlog.

## Recommended implementation slices

### Slice A - completed: durable queue safety

- Claim clan actions one at a time.
- Fence release by attempt and lease.
- Track claim, resolution, release, recovery, and `leftRunning`.

### Slice B - completed: independent clan admission

- Separate action and founder timers, guards, and budgets.
- Stagger the passes by half an interval.
- Include projection time in the founder deadline.
- Use protected-player budgets for both action and founder passes.
- Add rolling p95 metrics for queue, projection, execution, settlement,
  follow-up, scan loop, and total duration.

### Slice C - completed: governor foundation

- Added a process-wide token window with separate idle and protected-player
  caps, plus event-loop lag and database-queue admission gates.
- Added an exclusive `sqlite-heavy` resource lease, reservation refund,
  overrun debt, per-job flow counters, and explicit deferral reasons.
- Wired clan action, clan founder, and goal metadata passes first; remaining
  timers stay on their existing local admission until later slices.
- Preserved each service's existing running guard and local deadline as a
  second safety boundary.

### Slice D - in progress: timer consolidation

- Clan action, clan founder, stale-goal review, warehouse release, and market
  reconciliation now share one due-job registry with absolute deadlines,
  missed-period coalescing, and per-job re-entry protection.
- The three former goal-metadata stages are independently admitted against the
  same `sqlite-heavy` lease and shared token window. Their polling phases are
  staggered by one registry tick, so a slow stage cannot implicitly claim the
  next stage or permanently win same-tick admission order.
- Each stage keeps its normal ten-second cadence when caught up, but a full or
  deadline-limited pass continues in the next governor window. This preserves
  backlog throughput while allowing player/lag/DB pressure to be rechecked
  between stale goals, warehouse work, and market work.
- Clan actions now use the same backlog-aware continuation contract: a ready
  queue or budget stop retries in the next governor window, while a caught-up
  queue returns to the configured minute cadence. Claims remain one-at-a-time,
  so higher throughput does not reintroduce stranded running leases.
- Migrate the remaining low-frequency maintenance intervals incrementally
  after their local admission contracts are explicit.
- Keep high-frequency actor/effect timers outside this registry; they are a
  different player-facing workload class.

### Slice E - in progress: projection and cache discipline

- Require `EXPLAIN QUERY PLAN` and a representative-size performance test for
  population-wide projections.
- Stale goal projection now primes the goal cache and persists changed entries
  from the review slice in one SQLite transaction instead of issuing one read
  and one write per bot. The batch size and goal semantics remain unchanged.
- Market review reuses that batch path while retaining a per-bot spot, and
  warehouse candidate IDs are hydrated with one bounded state query. Neither
  change reduces candidate limits or suppresses world activity.
- Goal persistence uses one multi-row UPSERT inside the serialized transaction,
  rather than preparing and running one UPSERT statement per changed bot.
- Market discovery uses a bounded `(updatedAt, characterId)` keyset rotation
  backed by a lifecycle index. A bot that does not need market travel can no
  longer pin the oldest batch and starve the rest of the population.
- Cache immutable reference data indefinitely.
- Cache dynamic projections only with an explicit owner, TTL/version, and
  invalidation event.
- Prefer incremental cursors and dirty sets over repeated full snapshots.

### Slice F: worker-bound CPU work

- Profile synchronous stages before adding a worker.
- Move only pure snapshot-to-proposal computations.
- Cap worker in-flight work from main-thread lag and commit-queue pressure.
- Never let a worker claim more authoritative work than the commit path can
  settle before its lease.

### Slice G: adaptive throughput

- Tune batch/concurrency from rolling stage p95 and backlog age.
- Increase throughput only when lag, DB wait, and commit depth are below their
  low-water marks for a sustained window.
- Reduce immediately on a real-player transition or high-water mark.
- Keep static config as hard min/max bounds and an operational kill switch.

## Validation gates

Each slice must pass:

1. focused correctness and ownership/lease regressions;
2. syntax and full test whitelist;
3. clean diff/staged-scope checks;
4. single-process idle measurement;
5. protected-player measurement;
6. multi-process stress measurement, interpreted only as contention testing;
7. no growth in running leases, DB queue age, or unbounded worker proposals;
8. stable process/launcher status with coordinated restarts distinguished from
   crashes.

## Initial service-level objectives

These are control targets, not promises of hard real-time preemption:

- background admission begins throttling at 40 ms event-loop lag;
- no new non-critical background stage is admitted at 120 ms lag;
- protected-player P3/P4 token use is bounded across jobs, not per job;
- durable claimed work reaches a terminal state or is immediately released;
- SQLite-heavy jobs expose queue wait separately from execution time;
- every unsplittable stage has a measured p95 and an explicit owner.
