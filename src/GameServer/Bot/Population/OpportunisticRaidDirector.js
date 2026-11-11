'use strict';

const Policy = require('./OpportunisticRaidPolicy');
const SearchWork = require('./RaidSearchWork');
const Priority = require('./RaidRosterPriority');
const { RaidRosterCoverage } = require('./RaidRosterCoverage');
const { RaidSearchCounters, LIMITS } = require('./RaidSearchCounters');

// An indexed adventurer pool, one bounded proposal per opportunity, and the
// native party lifecycle. No boss sweep creates recruitment requests.
class OpportunisticRaidDirector {
    constructor(deps) {
        Object.assign(this, deps);
        this.pool = new Map();
        this.cooldowns = new Map();
        this.encounters = new Map();
        this.blockedBosses = new Map();
        this.placementFailures = new Map();
        this.lastFormedAt = 0;
        this.nextSearchAt = 0;
        this.nextForecastAt = 0;
        this.pendingSearch = null;
        this.now = deps.now || Date.now;
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
            if (packet.kind === 'reset') { this.finishSearch('interrupted'); this.nextSearchAt = 0; this.searchEpoch++; this.pool.clear(); this.coverage.clear(); this.deferredRosters = []; this.searchCounters.pendingRosters = 0; return; }
            const state = this.life.cachedState(Number(packet.characterId));
            if (state && Policy.available(state)) this.pool.set(state.characterId, state);
            else this.pool.delete(Number(packet.characterId));
        }, { replay: true });
        this.unsubscribeParty = this.parties.subscribeChanges(party => {
            if (!Policy.isObjective(party.stats?.objective)) return;
            this.lastFormedAt = Math.max(this.lastFormedAt, Number(party.startedAt));
            this.remember(party.memberIds, party.status === 'dissolved' ? Date.now() : party.startedAt);
        });
        await this.preparations?.start();
        for (const plan of this.preparations?.snapshot() || []) {
            this.lastFormedAt = Math.max(this.lastFormedAt, plan.startedAt);
            this.remember(plan.memberIds, plan.startedAt);
        }
    }

    stop() {
        this.finishSearch('interrupted');
        this.preparations?.stop();
        this.searchEpoch++;
        this.active = false; this.unsubscribeLife?.(); this.unsubscribeParty?.(); this.pool.clear();
        this.encounters.clear(); this.blockedBosses.clear(); this.placementFailures.clear();
        this.coverage.clear(); this.deferredRosters = []; this.searchCounters.pendingRosters = 0;
    }

    remember(ids, at) {
        for (const id of ids || []) this.cooldowns.set(Number(id), Math.max(this.cooldowns.get(Number(id)) || 0,
            at + this.config.opportunisticRaidMemberCooldownMs));
    }

    snapshot() { return { pool: this.pool.size, lastFormedAt: this.lastFormedAt,
        nextSearchAt: this.nextSearchAt, lastResult: this.lastResult,
        preparations: this.preparations?.snapshot() || [], search: this.searchCounters.snapshot() }; }

    room(spot, catalog, alive, admitted) {
        const band = Math.floor(spot.avgLevel / 10);
        const peers = catalog.filter(s => Math.floor(s.avgLevel / 10) === band);
        const claimed = new Set(admitted.map(p => Number(p.stats?.objective?.raidBossTemplateId || 0)));
        const free = peers.filter(s => alive.has(s.raidBossTemplateId) && !claimed.has(s.raidBossTemplateId));
        return free.length - 1 >= Math.ceil(peers.length * this.config.opportunisticRaidAliveFraction);
    }

    finishSearch(status) {
        if (this.pendingSearch) this.searchCounters.finish(status);
        this.pendingSearch = null;
        this.searchCounters.pendingRosters = this.deferredRosters.length;
    }

    retireRoster(ids) {
        const key = ids.join(':');
        this.deferredRosters = this.deferredRosters.filter(row => row.join(':') !== key);
        this.searchCounters.pendingRosters = this.deferredRosters.length;
    }

    refillForecastBudget(timestamp) {
        this.forecastCpuAt ??= timestamp;
        const windows = Math.max(0, Math.floor((timestamp - this.forecastCpuAt) / LIMITS.forecastWindowMs));
        this.forecastCpuTokens = Math.min(LIMITS.forecastCpuMs,
            this.forecastCpuTokens + windows * LIMITS.forecastCpuMs);
        this.forecastCpuAt += windows * LIMITS.forecastWindowMs;
        this.searchCounters.cpuBudget.availableMs = Math.max(0, this.forecastCpuTokens);
        this.searchCounters.cpuBudget.debtMs = Math.max(0, -this.forecastCpuTokens);
    }

    forecastAdmission(timestamp) {
        const pressure = this.forecastPressure?.(timestamp) || { ready: true, lagMs: 0, utilization: 0, pendingGoals: 0 };
        this.searchCounters.pacing.pressure = { ...pressure };
        const allowed = this.canWork() && pressure.ready && pressure.lagMs < LIMITS.workerLagMaxMs
            && pressure.utilization < LIMITS.workerBusyMax && !pressure.pendingGoals;
        if (!allowed) {
            this.searchCounters.pacing.loadDeferrals++;
            this.nextForecastAt = timestamp + LIMITS.forecastGapMs;
            this.lastResult = { reason: 'raid_worker_busy' };
        }
        return allowed ? pressure : null;
    }

    async discover(timestamp, admitted, scheduling) {
        const current = scheduling.current, yieldNow = scheduling.yieldNow || SearchWork.yieldToLoop;
        this.searchCounters.begin(timestamp);
        const shortlist = await SearchWork.run(Policy.candidateSteps([...this.pool.values()],
            this.cooldowns, this.tankCursor, timestamp, this.coverage, this.deferredRosters), scheduling);
        if (!shortlist || !current()) return;
        this.tankCursor = shortlist.tankCursor;
        for (const [reason, count] of Object.entries(shortlist.rejected))
            for (let i = 0; i < count; i++) this.searchCounters.reject('assembly', reason);
        for (const roster of shortlist.proposals) this.searchCounters.roster(roster);
        if (shortlist.candidates.length < 9) {
            this.searchCounters.reject('assembly', 'raid_candidates_small');
            this.lastResult = { reason: 'raid_candidates_small', count: shortlist.candidates.length };
            this.searchCounters.finish('no_candidates'); return;
        }
        const members = [];
        for (let offset = 0; offset < shortlist.candidates.length; offset += 16) {
            const ids = shortlist.candidates.slice(offset, offset + 16).map(s => s.characterId);
            await this.memory.ensureMany(ids);
            if (!current()) return;
            members.push(...await this.life.statesByIds(ids));
            if (!current()) return;
            this.searchCounters.add('hydratedBots', ids.length);
            await yieldNow();
        }
        const rosters = await SearchWork.run(Policy.proposalSteps(shortlist.proposals, members,
            this.memory.assess.bind(this.memory), timestamp, this.searchCounters), scheduling);
        if (!rosters || !current()) return;
        this.rosterWindowCursor = ((this.rosterWindowCursor || 0) + 1) % 3;
        this.searchCounters.add('rostersProposed', rosters.length);
        this.deferredRosters = rosters.map(roster => roster.map(s => s.characterId));
        this.searchCounters.pendingRosters = this.deferredRosters.length;
        if (!rosters.length) {
            this.lastResult = { reason: 'raid_compatible_roster_missing' };
            this.searchCounters.finish('no_roster'); return;
        }
        const catalog = this.catalog.all(), alive = this.catalog.liveTemplateIds();
        for (const [id, until] of this.blockedBosses) if (until <= timestamp) this.blockedBosses.delete(id);
        const claimed = new Set(admitted.map(p => Number(p.stats?.objective?.raidBossTemplateId || 0)));
        const start = shortlist.priorityKey ? (this.rosterCursor || 0) % rosters.length : 0;
        const ordered = [...rosters.slice(start), ...rosters.slice(0, start)];
        this.rosterCursor = start + 1;
        const priorityIndex = ordered.findIndex(r => r.map(s => s.characterId).join(':') === shortlist.priorityKey);
        if (priorityIndex > 0) ordered.unshift(...ordered.splice(priorityIndex, 1));
        const scores = new Map();
        const score = spot => {
            if (!scores.has(spot.raidBossTemplateId)) scores.set(spot.raidBossTemplateId, Priority.targetScore(spot));
            return scores.get(spot.raidBossTemplateId);
        };
        const queues = ordered.map(roster => {
            const ids = roster.map(s => s.characterId), priority = ids.join(':') === shortlist.priorityKey;
            const key = `${priority ? 'priority:' : ''}${Math.min(...roster.map(s => s.level))}:${Math.max(...roster.map(s => s.level))}`;
            const all = catalog.filter(s => alive.has(s.raidBossTemplateId) && !claimed.has(s.raidBossTemplateId)
                && !this.blockedBosses.has(s.raidBossTemplateId) && roster.every(m => Policy.recruitLevelAllowed(m, s.avgLevel)))
                .sort((a,b) => score(a) - score(b) || a.avgLevel - b.avgLevel || a.raidBossTemplateId - b.raidBossTemplateId);
            const offset = (this.bossCursors.get(key) || 0) % Math.max(1, all.length);
            if (!all.length) { this.searchCounters.reject('target', 'raid_no_eligible_boss'); this.retireRoster(ids); }
            return { ids, key, offset, cursor: 0, choices: [...all.slice(offset), ...all.slice(0, offset)] };
        });
        // Keep IDs and immutable target definitions only. Every paced check
        // re-reads current native members and diplomacy before asking the worker.
        this.pendingSearch = { queues, cursor: 0, remaining: LIMITS.forecasts,
            assessed: new Set(), expiresAt: timestamp + this.config.opportunisticRaidSearchIntervalMs };
    }

    async forecastOne(timestamp, admitted, current) {
        const search = this.pendingSearch, catalog = this.catalog.all(), alive = this.catalog.liveTemplateIds();
        const claimed = new Set(admitted.map(p => Number(p.stats?.objective?.raidBossTemplateId || 0)));
        for (let tried = 0; tried < search.queues.length; tried++) {
            const queue = search.queues[search.cursor++ % search.queues.length];
            if (queue.cursor >= queue.choices.length) continue;
            const roster = queue.ids.map(id => this.life.cachedState(id));
            this.searchCounters.add('revalidatedBots', roster.length);
            const valid = roster.every(s => s && Policy.candidateReady(s, timestamp)) && Policy.composition(roster).ready
                && roster.every((s,i) => roster.slice(i+1).every(peer =>
                    Policy.compatible(s, peer, this.memory.assess.bind(this.memory), timestamp)));
            if (!valid) {
                this.searchCounters.reject('assembly', 'raid_members_changed');
                queue.cursor = queue.choices.length; this.retireRoster(queue.ids); continue;
            }
            // Gather a bounded batch cooperatively. The worker prepares this
            // roster once and selects the shortest viable encounter itself.
            const startCursor = queue.cursor, targets = [];
            let inspected = startCursor;
            while (inspected < queue.choices.length && targets.length < LIMITS.targetCandidates) {
                const next = queue.choices[inspected++];
                if (inspected % 8 === 0) {
                    await (this.searchScheduling?.yieldNow || SearchWork.yieldToLoop)();
                    if (!current()) return;
                }
                if (!alive.has(next.raidBossTemplateId) || claimed.has(next.raidBossTemplateId)
                    || !roster.every(m => Policy.recruitLevelAllowed(m, next.avgLevel))) continue;
                if (!this.room(next, catalog, alive, admitted)) { this.searchCounters.reject('target', 'raid_alive_reserve'); continue; }
                if (!this.bossFree(next)) { this.searchCounters.reject('target', 'raid_boss_busy'); continue; }
                targets.push(next);
            }
            if (!targets.length) { queue.cursor = inspected; this.retireRoster(queue.ids); continue; }
            const pressure = this.forecastAdmission(Math.max(timestamp, this.now()));
            if (!pressure || !current()) { search.cursor--; return; }
            const key = queue.ids.join(':');
            if (!search.assessed.has(key)) { search.assessed.add(key); this.searchCounters.add('rostersAssessed'); }
            let spot = targets[0];
            const assessment = await this.assess(roster, spot, timestamp, { fundSupplies: true, targets });
            if (!current()) return;
            const selected = assessment.targetSelection;
            if (selected?.fullForecast) spot = targets.find(s => s.raidBossTemplateId === selected.bossId);
            if (!spot) { this.finishSearch('invalid_target_selection'); return; }
            if (selected && !selected.fullForecast) {
                queue.cursor = inspected;
            } else {
                // Move only the fully assessed target out of this window's
                // queue. The other targets are re-screened with fresh members
                // on the next turn, so old estimates never authorize a fight.
                const index = queue.choices.indexOf(spot);
                [queue.choices[startCursor], queue.choices[index]] = [queue.choices[index], queue.choices[startCursor]];
                queue.cursor = startCursor + 1;
            }
            this.searchCounters.forecast(assessment, selected?.bossId ?? spot.raidBossTemplateId);
            const workMs = Math.max(0, Number(assessment.workMs) || 0);
            this.forecastCpuTokens -= workMs;
            this.refillForecastBudget(Math.max(timestamp, this.now()));
            // Adapt spacing to measured CPU: 20 ms costs ten seconds of a
            // 120 ms/minute allowance. Never catch up with a burst after load.
            const spacing = Math.max(LIMITS.forecastGapMs, workMs * LIMITS.forecastWindowMs / LIMITS.forecastCpuMs);
            const slow = pressure.utilization >= .75 || pressure.lagMs >= 60 ? 2 : 1;
            this.nextForecastAt = Math.max(timestamp, this.now()) + Math.ceil(spacing * slow);
            this.searchCounters.pacing.nextForecastAt = this.nextForecastAt;
            this.retireRoster(queue.ids);
            this.bossCursors.delete(queue.key);
            this.bossCursors.set(queue.key, (queue.offset + queue.cursor) % Math.max(1, queue.choices.length));
            if (this.bossCursors.size > 256) this.bossCursors.delete(this.bossCursors.keys().next().value);
            this.lastResult = { ...assessment, bossId: selected?.bossId ?? spot.raidBossTemplateId,
                members: roster.map(s => ({ id: s.characterId, name: s.name, level: s.level })) };
            search.remaining--;
            if (assessment.ready && this.canWork() && this.bossFree(spot)) {
                const objective = { status: 'open', priority: 'required', reason: 'opportunistic_raid', sourceKind: 'raid',
                    opportunisticRaid: true, raidBoss: true, raidBossTemplateId: spot.raidBossTemplateId,
                    npcId: spot.raidBossTemplateId, sourceLevel: spot.avgLevel, spotId: spot.id,
                    minPartySize: 9, maxPartySize: 9, requestedAt: timestamp,
                    expiresAt: timestamp + this.config.opportunisticRaidExpeditionMs, assessment };
                const needsSupplies = assessment.supplies?.some(s => s.missing > 0);
                const party = needsSupplies ? await this.preparations?.reserve(roster, objective, timestamp)
                    : await this.form(roster, objective);
                if (!current()) return;
                if (party) {
                    if (needsSupplies) this.searchCounters.add('preparationsStarted');
                    this.lastFormedAt = Math.max(timestamp, Number(party.startedAt || 0));
                    this.remember(party.memberIds, this.lastFormedAt);
                    this.lastResult = { ...this.lastResult, ...(needsSupplies
                        ? { reason: 'raid_preparing_supplies', preparationId: party.id } : { formedPartyId: party.partyId }) };
                    this.finishSearch(needsSupplies ? 'preparing' : 'formed'); return;
                }
                this.searchCounters.reject('admission', needsSupplies ? 'raid_preparation_refused' : 'raid_formation_refused');
            }
            if (this.forecastCpuTokens <= 0) this.finishSearch('forecast_cpu_budget');
            else if (!search.remaining) this.finishSearch('forecast_budget');
            else this.searchCounters.finish('waiting_pace');
            return; // One worker forecast per scheduler turn.
        }
        this.finishSearch('complete');
    }

    async pulse(timestamp = Date.now()) {
        if (!this.active || this.running) return;
        this.running = true;
        const epoch = this.searchEpoch, current = () => this.active && this.searchEpoch === epoch;
        try {
            await this.maintain(timestamp);
            if (!current() || timestamp < this.nextForecastAt) return;
            if (timestamp - this.lastFormedAt < this.config.opportunisticRaidIntervalMs) return;
            const admitted = [...this.parties.admitted(), ...(this.preparations?.admitted() || [])];
            if (admitted.filter(p => Policy.isObjective(p.stats?.objective)).length >= this.config.opportunisticRaidMaxParties) return;
            if (this.pendingSearch && timestamp >= this.pendingSearch.expiresAt) this.finishSearch('window_expired');
            if (!this.pendingSearch && timestamp < this.nextSearchAt) return;
            if (!this.forecastAdmission(timestamp)) return;
            this.refillForecastBudget(timestamp);
            if (this.forecastCpuTokens <= 0) {
                this.searchCounters.cpuBudget.deferredSearches++;
                this.nextForecastAt = this.forecastCpuAt + LIMITS.forecastWindowMs;
                this.lastResult = { reason: 'raid_forecast_cpu_rest' }; return;
            }
            if (!this.pendingSearch) {
                this.nextSearchAt = timestamp + this.config.opportunisticRaidSearchIntervalMs;
                await this.discover(timestamp, admitted, { ...this.searchScheduling, current });
                if (!current() || !this.pendingSearch) return;
            }
            await this.forecastOne(timestamp, admitted, current);
        } finally {
            this.searchCounters.pacing.nextForecastAt = this.nextForecastAt;
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
                        this.blockedBosses.set(objective.raidBossTemplateId, timestamp + 30 * 60000);
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
                if (sessions.some(s => s.partyGroundPickupInProgress)) continue;
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
            const stalled = timestamp - progress.progressAt > 8 * 60000;
            if (stalled || timestamp - progress.startedAt > 25 * 60000 || objective.expiresAt <= timestamp
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
