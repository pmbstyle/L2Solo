'use strict';

const Policy = require('./OpportunisticRaidPolicy');
const SearchWork = require('./RaidSearchWork');
const Priority = require('./RaidRosterPriority');
const { RaidRosterCoverage } = require('./RaidRosterCoverage');
const { RaidSearchCounters, LIMITS } = require('./RaidSearchCounters');
const Trace = require('../DecisionTrace');

// An indexed adventurer pool, one bounded proposal per opportunity, and the
// native party lifecycle. No boss sweep creates recruitment requests.
// A search runs at its situations (wake), never on a clock: the director's start,
// a raid boss spawned (RaidEntityIndex), a raid party ended, the pacing end
// (lastFormedAt + opportunisticRaidIntervalMs, armed once), and raid_opportunity (the
// available pool grew by a roster, 9, since the last search that formed nothing). A
// search starts only with its whole forecast CPU allowance (a rate: it refills by
// LIMITS.forecastCpuMs per forecastRefillMs); one busy main or that allowance cut stays
// due and goes on with its deferred rosters only (draining: fresh rosters wait for the
// next situation, raid_opportunity among them) once main is free or the allowance full
// again, and ends when that queue is empty; one the forecast cap (count, deadline) cut
// ends there. A boss whose encounter
// could not be placed is held out until its next spawn. Member cooldowns are reads.
const ROSTER = 9;
const BUDGET_CUT = new Set(['busy', 'forecast_cpu_budget']);
class OpportunisticRaidDirector {
    constructor(deps) {
        Object.assign(this, deps);
        this.pool = new Map();
        this.cooldowns = new Map();
        this.encounters = new Map();
        this.unreachableBosses = new Set();
        this.spawnedBosses = new Set();
        this.placementFailures = new Map();
        this.lastFormedAt = 0;
        // due: the reason of the pending search (null: none); pacingAt: the pacing
        // end's wake, armed once; poolAtFailure: the pool after a search that formed
        // nothing (null: none since).
        this.due = null;
        this.pacingAt = 0;
        this.poolAtFailure = null;
        // draining: the due search was cut after proposing its rosters; it goes on with them.
        this.draining = false;
        this.running = false;
        this.active = false;
        this.lastResult = { reason: 'starting' };
        this.searchEpoch = 0;
        this.bossCursors = new Map();
        this.coverage = new RaidRosterCoverage();
        this.searchCounters = new RaidSearchCounters();
        this.forecastCpuTokens = LIMITS.forecastCpuMs;
        this.forecastCpuAt = null;
        this.deferredRosters = [];
        const form = this.form;
        if (form) this.form = async (...args) => {
            const party = await form.apply(this, args);
            if (party) this.searchCounters.formed();
            return party;
        };
    }

    async start() {
        this.active = true;
        const rows = await this.database.execute([`SELECT startedAt, updatedAt, memberIdsJson
            FROM bot_background_parties WHERE json_extract(statsJson, '$.objective.opportunisticRaid') = 1
            AND updatedAt >= ?`, [Date.now() - Math.max(this.config.opportunisticRaidMemberCooldownMs,
            this.config.opportunisticRaidIntervalMs)], { read: true }], 'raid-opportunity:history');
        if (!this.active) return;
        for (const row of rows) {
            this.lastFormedAt = Math.max(this.lastFormedAt, Number(row.startedAt));
            this.remember(JSON.parse(row.memberIdsJson || '[]'), Number(row.updatedAt));
        }
        this.unsubscribeLife = this.life.subscribePublications(packet => {
            if (!this.active) return;
            if (packet.kind === 'reset') { this.searchEpoch++; this.pool.clear(); this.coverage.clear(); this.deferredRosters = []; this.searchCounters.pendingRosters = 0; return; }
            const state = this.life.cachedState(Number(packet.characterId));
            if (state && Policy.available(state)) this.pool.set(state.characterId, state);
            else this.pool.delete(Number(packet.characterId));
            if (this.poolAtFailure !== null && this.pool.size >= this.poolAtFailure + ROSTER) this.wake('raid_opportunity');
        }, { replay: true });
        this.unsubscribeParty = this.parties.subscribeChanges(party => {
            if (!Policy.isObjective(party.stats?.objective)) return;
            this.lastFormedAt = Math.max(this.lastFormedAt, Number(party.startedAt));
            this.remember(party.memberIds, party.status === 'dissolved' ? Date.now() : party.startedAt);
            if (party.status === 'dissolved') this.wake('raid_ended');
        });
        // Told inside the index's writes: the boss is looked up at the next pulse.
        this.unsubscribeBoss = this.onBossChanged?.(templateId => { if (this.active) this.spawnedBosses.add(Number(templateId)); });
        await this.preparations?.start();
        for (const plan of this.preparations?.snapshot() || []) {
            this.lastFormedAt = Math.max(this.lastFormedAt, plan.startedAt);
            this.remember(plan.memberIds, plan.startedAt);
        }
        this.wake('start');
    }

    // A search is due (its situation: reason). Held until a search runs it.
    wake(reason) {
        if (!this.active) return;
        this.due ||= reason;
        this.poolAtFailure = null;
        this.draining = false;
    }

    stop() {
        this.preparations?.stop();
        this.searchEpoch++;
        this.active = false; this.unsubscribeLife?.(); this.unsubscribeParty?.(); this.unsubscribeBoss?.(); this.pool.clear();
        this.encounters.clear(); this.unreachableBosses.clear(); this.spawnedBosses.clear(); this.placementFailures.clear();
        this.due = null; this.pacingAt = 0; this.poolAtFailure = null; this.draining = false;
        this.coverage.clear(); this.deferredRosters = []; this.searchCounters.pendingRosters = 0;
    }

    remember(ids, at) {
        for (const id of ids || []) this.cooldowns.set(Number(id), Math.max(this.cooldowns.get(Number(id)) || 0,
            at + this.config.opportunisticRaidMemberCooldownMs));
    }

    snapshot() { return { pool: this.pool.size, lastFormedAt: this.lastFormedAt,
        due: this.due, pacingAt: this.pacingAt, lastResult: this.lastResult,
        preparations: this.preparations?.snapshot() || [], search: this.searchCounters.snapshot() }; }

    room(spot, catalog, alive, admitted) {
        const band = Math.floor(spot.avgLevel / 10);
        const peers = catalog.filter(s => Math.floor(s.avgLevel / 10) === band);
        const claimed = new Set(admitted.map(p => Number(p.stats?.objective?.raidBossTemplateId || 0)));
        const free = peers.filter(s => alive.has(s.raidBossTemplateId) && !claimed.has(s.raidBossTemplateId));
        return free.length - 1 >= Math.ceil(peers.length * this.config.opportunisticRaidAliveFraction);
    }

    async pulse(timestamp = Date.now()) {
        if (!this.active || this.running) return;
        this.running = true;
        const epoch = this.searchEpoch;
        const current = () => this.active && this.searchEpoch === epoch;
        const scheduling = { ...this.searchScheduling, current };
        const yieldNow = scheduling.yieldNow || SearchWork.yieldToLoop;
        let searchStarted = false, searchStatus = 'complete', cpuAllowance = 0, proposed = false;
        try {
            await this.maintain(timestamp);
            if (!current()) return;
            // A boss back in the index (its spawn): its unreachable mark ends, a search is due.
            for (const id of this.spawnedBosses) {
                this.spawnedBosses.delete(id);
                if (!this.bossAlive?.(id)) continue;
                this.unreachableBosses.delete(id);
                this.wake('boss_spawned');
            }
            if (this.pacingAt && timestamp >= this.pacingAt) { this.pacingAt = 0; this.wake('pacing_end'); }
            if (!this.due) return;
            // Pacing and the party cap hold the search: their ends wake it again.
            if (timestamp - this.lastFormedAt < this.config.opportunisticRaidIntervalMs) {
                this.pacingAt = this.lastFormedAt + this.config.opportunisticRaidIntervalMs; this.due = null; return;
            }
            const admitted = [...this.parties.admitted(), ...(this.preparations?.admitted() || [])];
            if (admitted.filter(p => Policy.isObjective(p.stats?.objective)).length >= this.config.opportunisticRaidMaxParties) {
                this.due = null; return;
            }
            if (!this.canWork()) { this.lastResult = { reason: 'raid_background_busy' }; return; }
            // A synchronous forecast can overrun the allowance once. Charge
            // that debt to the following refill windows instead of adding the
            // same overrun every search.
            this.forecastCpuAt ??= timestamp;
            const windows = Math.max(0, Math.floor((timestamp - this.forecastCpuAt) / LIMITS.forecastRefillMs));
            this.forecastCpuTokens = Math.min(LIMITS.forecastCpuMs,
                this.forecastCpuTokens + windows * LIMITS.forecastCpuMs);
            this.forecastCpuAt += windows * LIMITS.forecastRefillMs;
            this.searchCounters.cpuBudget.availableMs = Math.max(0, this.forecastCpuTokens);
            this.searchCounters.cpuBudget.debtMs = Math.max(0, -this.forecastCpuTokens);
            if (this.forecastCpuTokens < LIMITS.forecastCpuMs) {
                this.searchCounters.cpuBudget.deferredSearches++;
                this.lastResult = { reason: 'raid_forecast_cpu_rest' }; return;
            }
            cpuAllowance = this.forecastCpuTokens;
            this.searchCounters.begin(timestamp, this.due); searchStarted = true;
            // Hydrate a rotating, bounded slice. Recent publication order must
            // not permanently hide an older tank or healer.
            const shortlist = await SearchWork.run(Policy.candidateSteps([...this.pool.values()],
                this.cooldowns, this.tankCursor, timestamp, this.coverage, this.deferredRosters, this.draining), scheduling);
            if (!shortlist) { searchStatus = 'busy'; return; }
            const { candidates } = shortlist;
            this.tankCursor = shortlist.tankCursor;
            for (const [reason, count] of Object.entries(shortlist.rejected))
                for (let i = 0; i < count; i++) this.searchCounters.reject('assembly', reason);
            for (const roster of shortlist.proposals) this.searchCounters.roster(roster);
            if (candidates.length < 9) {
                this.searchCounters.reject('assembly', 'raid_candidates_small');
                this.lastResult = { reason: 'raid_candidates_small', count: candidates.length };
                searchStatus = 'no_candidates'; return;
            }
            const members = [];
            // Normalizing a returned row and publishing its cache entry also
            // runs on Main. Small pages bound that work as well as selection.
            for (let offset = 0; offset < candidates.length; offset += 16) {
                if (!current()) return;
                const ids = candidates.slice(offset, offset + 16).map(s => s.characterId);
                await this.memory.ensureMany(ids);
                if (!current()) return;
                members.push(...await this.life.statesByIds(ids));
                this.searchCounters.add('hydratedBots', ids.length);
                if (!current()) return;
                await yieldNow();
            }
            const windowCursor = this.rosterWindowCursor || 0;
            const rosters = await SearchWork.run(Policy.proposalSteps(shortlist.proposals, members,
                this.memory.assess.bind(this.memory), timestamp, this.searchCounters), scheduling);
            if (!rosters) { searchStatus = 'busy'; return; }
            this.rosterWindowCursor = (windowCursor + 1) % 3;
            this.searchCounters.add('rostersProposed', rosters.length);
            this.deferredRosters = rosters.map(roster => roster.map(s => s.characterId)); proposed = true;
            if (!rosters.length) { this.lastResult = { reason: 'raid_compatible_roster_missing' }; searchStatus = 'no_roster'; return; }
            const catalog = this.catalog.all(), alive = this.catalog.liveTemplateIds();
            const claimed = new Set(admitted.map(p => Number(p.stats?.objective?.raidBossTemplateId || 0)));
            // A coverage pass drains the fresh, revalidated deferred queue in
            // order. Rotating it again could hide the adjacent strong cohort
            // behind newly proposed weak tanks for many forecast intervals.
            const start = shortlist.priorityKey ? (this.rosterCursor || 0) % rosters.length : 0;
            const ordered = [...rosters.slice(start), ...rosters.slice(0, start)];
            this.rosterCursor = start + 1;
            const priorityIndex = ordered.findIndex(roster => roster.map(s => s.characterId).join(':') === shortlist.priorityKey);
            if (priorityIndex > 0) ordered.unshift(...ordered.splice(priorityIndex, 1));
            const retire = roster => {
                const key = roster.map(s => s.characterId).join(':');
                this.deferredRosters = this.deferredRosters.filter(ids => ids.join(':') !== key);
            };
            const deadline = Date.now() + 12000;
            let remaining = 12;
            const assessedRosters = new Set();
            const targetScores = new Map();
            const targetScore = spot => {
                if (!targetScores.has(spot.raidBossTemplateId)) targetScores.set(spot.raidBossTemplateId, Priority.targetScore(spot));
                return targetScores.get(spot.raidBossTemplateId);
            };
            const queues = ordered.map(roster => {
                const priority = roster.map(s => s.characterId).join(':') === shortlist.priorityKey;
                const key = `${priority ? 'priority:' : ''}${Math.min(...roster.map(s => s.level))}:${Math.max(...roster.map(s => s.level))}`;
                const all = catalog.filter(s => alive.has(s.raidBossTemplateId) && !claimed.has(s.raidBossTemplateId)
                    && !this.unreachableBosses.has(s.raidBossTemplateId)
                    && roster.every(m => Policy.recruitLevelAllowed(m, s.avgLevel)))
                    .sort((a, b) => targetScore(a) - targetScore(b)
                        || a.avgLevel - b.avgLevel || a.raidBossTemplateId - b.raidBossTemplateId);
                const offset = (this.bossCursors.get(key) || 0) % Math.max(1, all.length);
                if (!all.length) { this.searchCounters.reject('target', 'raid_no_eligible_boss'); retire(roster); }
                return { roster, key, offset, cursor: 0, choices: [...all.slice(offset), ...all.slice(0, offset)] };
            });
            // Spend the same bounded worker budget across rosters first.
            // One weak roster with many bosses must not hide a viable one.
            while (queues.some(q => q.cursor < q.choices.length)) {
                for (const queue of queues) {
                    const { roster, choices } = queue;
                    let spot;
                    while (queue.cursor < choices.length) {
                        const next = choices[queue.cursor++];
                        if (!this.room(next, catalog, alive, admitted)) { this.searchCounters.reject('target', 'raid_alive_reserve'); continue; }
                        if (!this.bossFree(next)) { this.searchCounters.reject('target', 'raid_boss_busy'); continue; }
                        spot = next; break;
                    }
                    if (!spot) { retire(roster); continue; }
                    if (this.searchCounters.last.forecastWorkMs >= cpuAllowance) { searchStatus = 'forecast_cpu_budget'; return; }
                    if (!remaining-- || Date.now() >= deadline || !this.active) { searchStatus = 'forecast_budget'; return; }
                    if (!assessedRosters.has(roster)) { assessedRosters.add(roster); this.searchCounters.add('rostersAssessed'); }
                    const assessment = await this.assess(roster, spot, timestamp, { fundSupplies: true });
                    this.searchCounters.forecast(assessment, spot.raidBossTemplateId);
                    retire(roster);
                    this.bossCursors.delete(queue.key);
                    this.bossCursors.set(queue.key, (queue.offset + queue.cursor) % Math.max(1, choices.length));
                    if (this.bossCursors.size > 256) this.bossCursors.delete(this.bossCursors.keys().next().value);
                    if (!current()) return;
                    this.lastResult = { ...assessment, bossId: spot.raidBossTemplateId,
                        members: roster.map(s => ({ id: s.characterId, name: s.name, level: s.level })) };
                    if (!assessment.ready) continue;
                    if (!current() || !this.canWork()) { searchStatus = 'busy'; return; }
                    const objective = { status: 'open', priority: 'required', reason: 'opportunistic_raid', sourceKind: 'raid',
                        opportunisticRaid: true, raidBoss: true, raidBossTemplateId: spot.raidBossTemplateId,
                        npcId: spot.raidBossTemplateId, sourceLevel: spot.avgLevel, spotId: spot.id,
                        minPartySize: 9, maxPartySize: 9, requestedAt: timestamp,
                        expiresAt: timestamp + this.config.opportunisticRaidExpeditionMs, assessment };
                    const needsSupplies = assessment.supplies?.some(s => s.missing > 0);
                    const party = needsSupplies
                        ? await this.preparations?.reserve(roster, objective, timestamp)
                        : await this.form(roster, objective);
                    // A ready roster put to its boss: formed, its supplies' preparation begun, or refused.
                    if (Trace.on()) Trace.record({ kind: 'raid', bot: Number(roster[0]?.characterId), phase: 'forming',
                        outcome: !party ? 'refused' : needsSupplies ? 'preparing' : 'formed', party: party?.partyId ? String(party.partyId) : undefined,
                        npcId: Number(spot.raidBossTemplateId), members: roster.length });
                    if (party) {
                        if (needsSupplies) this.searchCounters.add('preparationsStarted');
                        searchStatus = needsSupplies ? 'preparing' : 'formed';
                        this.lastFormedAt = Math.max(timestamp, Number(party.startedAt || 0));
                        this.remember(party.memberIds, this.lastFormedAt);
                        this.lastResult = { ...this.lastResult, ...(needsSupplies
                            ? { reason: 'raid_preparing_supplies', preparationId: party.id }
                            : { formedPartyId: party.partyId }) };
                        return;
                    }
                    this.searchCounters.reject('admission', needsSupplies ? 'raid_preparation_refused' : 'raid_formation_refused');
                }
                await yieldNow();
                if (!current() || !this.canWork()) { searchStatus = 'busy'; return; }
            }
        } finally {
            if (searchStarted) {
                this.forecastCpuTokens -= this.searchCounters.last.forecastWorkMs;
                this.searchCounters.cpuBudget.availableMs = Math.max(0, this.forecastCpuTokens);
                this.searchCounters.cpuBudget.debtMs = Math.max(0, -this.forecastCpuTokens);
                this.searchCounters.pendingRosters = this.deferredRosters.length;
                this.searchCounters.finish(current() ? searchStatus : 'interrupted');
                // One record per search run: the situation that made it due, how it ended.
                if (Trace.on()) Trace.record({ kind: 'raid', phase: 'search', reason: String(this.due || ''),
                    outcome: String(current() ? searchStatus : 'interrupted') });
                this.config.developerDiagnostics && console.info('BotPopulation :: raid search woken=%s status=%s', this.due, searchStatus);
                // Done: a formed party paces the next; one that formed nothing waits for a
                // situation (the pool's growth among them). A search busy main or the CPU
                // allowance cut stays due while rosters it proposed wait in its queue.
                const cut = BUDGET_CUT.has(searchStatus);
                if (cut && proposed) this.draining = true;
                if ((!cut || this.draining && !this.deferredRosters.length) && current()) {
                    this.due = null; this.draining = false;
                    if (!['formed', 'preparing'].includes(searchStatus)) this.poolAtFailure = this.pool.size;
                }
            }
            this.running = false;
        }
    }

    observeProgress(party, boss, sessions, timestamp) {
        const progress = this.encounters.get(party.partyId) || {
            startedAt: Number(party.stats?.hotLifecycle?.startedAt) || timestamp,
            progressAt: timestamp, hp: boss.fetchHp(), minions: new Map()
        };
        if (boss.fetchHp() < progress.hp) { progress.hp = boss.fetchHp(); progress.progressAt = timestamp; }
        // Boss regeneration can hide all progress while the DDs kill guards.
        // Track their native HP and removal too; new full-health waves and
        // healing never reset the clock by themselves.
        const present = new Set();
        for (const npc of this.raidEntities?.(boss) || []) {
            if (npc === boss) continue;
            const id = npc.fetchId(), hp = npc.fetchHp(), before = progress.minions.get(id);
            present.add(id);
            if (hp < (before ?? npc.fetchMaxHp())) progress.progressAt = timestamp;
            progress.minions.set(id, Math.min(before ?? hp, hp));
        }
        for (const [id, hp] of progress.minions) if (!present.has(id)) {
            if (hp > 0) progress.progressAt = timestamp;
            progress.minions.delete(id);
        }
        // A completed native buff advances preparation, an intended or
        // rejected cast does not. Once combat preparation ends, rebuffs
        // cannot conceal a stalled fight. The hard hot-time limit remains.
        if (!progress.prepared) for (const session of sessions) {
            const outcome = session.lastSupportOutcome;
            if (outcome?.outcome === 'landed' && outcome.at >= progress.startedAt && outcome.at <= timestamp)
                progress.progressAt = Math.max(progress.progressAt, outcome.at);
        }
        progress.prepared ||= sessions.some(s => s.raidPreparationComplete);
        this.encounters.set(party.partyId, progress);
        return progress;
    }

    async maintain(timestamp) {
        timestamp ??= Date.now();
        if (!this.active || this.maintaining) return;
        this.maintaining = true;
        try {
        if (this.preparations && this.canWork()) await this.preparations.maintain(timestamp);
        const parties = this.parties.admitted().filter(p => Policy.isObjective(p.stats?.objective));
        const kept = new Set(parties.map(p => p.partyId));
        for (const key of this.encounters.keys()) if (!kept.has(key)) this.encounters.delete(key);
        for (const key of this.placementFailures.keys()) if (!kept.has(key)) this.placementFailures.delete(key);
        for (const party of parties) {
            const objective = party.stats.objective;
            if (party.status === 'active') {
                if (!this.canWork()) continue;
                const states = await this.life.statesByIds(party.memberIds);
                if (objective.expiresAt <= timestamp || states.length !== 9
                    || states.some(s => s.level > objective.sourceLevel + 8)) {
                    await this.dissolve(party, 'raid_unavailable'); continue;
                }
                const spot = this.catalog.findById(objective.spotId);
                if (!this.assembly.ready(party, states, spot)) continue;
                await this.memory.ensureMany(party.memberIds);
                const social = states.every((s, i) => states.slice(i + 1).every(peer =>
                    Policy.compatible(s, peer, this.memory.assess.bind(this.memory), timestamp)));
                const check = await this.assess(states, spot, timestamp);
                if (!check.ready && /^(party_goal_|worker_|raid_assessment_unavailable)/.test(check.reason || '')) continue;
                if (!social || !check.ready || !this.bossFree(spot, party.partyId, party.memberIds)) {
                    await this.dissolve(party, 'raid_unavailable'); continue;
                }
                const latest = this.parties.find(party.partyId);
                if (!latest || latest.status !== 'active' || !this.active) continue;
                await this.parties.createOrUpdate({ ...latest, stats: { ...latest.stats,
                    objective: { ...latest.stats.objective, assessment: check } } });
                const activated = await this.hot.activate(party.partyId, 'opportunistic_raid', { raidFanout: false });
                this.lastResult = { reason: activated.ok ? 'raid_combat_activated' : activated.reason,
                    detail: activated.detail, partyId: party.partyId, bossId: objective.raidBossTemplateId };
                if (activated.ok) this.placementFailures.delete(party.partyId);
                else if (activated.reason === 'party_no_safe_placement') {
                    const failures = (this.placementFailures.get(party.partyId) || 0) + 1;
                    this.placementFailures.set(party.partyId, failures);
                    if (failures >= 3) {
                        this.unreachableBosses.add(Number(objective.raidBossTemplateId));
                        this.lastResult.reason = 'raid_boss_unreachable';
                        await this.dissolve(party, 'raid_boss_unreachable');
                    }
                }
                continue;
            }
            const sessions = this.sessions().filter(s => s.hotBackgroundPartyId === party.partyId);
            const boss = this.bossFor(objective.raidBossTemplateId);
            const defeated = this.defeated(objective.raidBossTemplateId);
            if (!boss || boss.isDead?.()) {
                if (!defeated || defeated.updatedAt < party.startedAt) {
                    if (sessions[0]) await this.hot.abandonRaid(sessions[0], 'raid_unavailable', timestamp);
                    continue;
                }
                if (sessions.some(s => invoke('GameServer/Bot/AI/PartyCompanionService').collectingGroundLoot(s))) continue;
                if (this.canFinish?.(sessions) === false) continue;
                // Finish the current buff cast without allowing a new queue
                // after the victory's level-up and skill training.
                sessions.forEach(s => this.ai.stop(s));
                const result = await this.hot.cooldown(party.partyId, 'raid_defeated', { ignoreVisibility: true, raidFanout: false });
                if (result.ok) await this.dissolve(this.parties.find(party.partyId) || party, 'raid_defeated');
                continue;
            }
            if (party.stats?.raidEncounter?.status === 'failed') continue;
            const progress = this.observeProgress(party, boss, sessions, timestamp);
            // In the fight only the stall insurance: 8 min with no boss, minion or buff progress.
            const stalled = timestamp - progress.progressAt > 8 * 60000;
            if (stalled || objective.expiresAt <= timestamp
                || sessions.some(s => s.actor.fetchLevel() > objective.sourceLevel + 8
                    || Number(s.actor.fetchKarma?.()) > 0 || Number(s.actor.fetchPk?.()) > 0)) {
                if (sessions[0]) await this.hot.abandonRaid(sessions[0], stalled ? 'raid_no_progress' : 'raid_admission_expired', timestamp);
                continue;
            }
            for (const session of sessions) {
                session.populationHotAt = timestamp;
                this.lod.promote(session, 'opportunistic_raid', timestamp);
            }
        }
        } finally { this.maintaining = false; }
    }
}

module.exports = { OpportunisticRaidDirector };
