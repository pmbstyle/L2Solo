'use strict';
const Config = require('./ClanWarConfig');
const Policy = require('./ClanWarPolicy');
const Rules = require('./ClanWarRules');
const Home = require('../Bot/Population/ClanWarHome');
const clanOf = s => Number(s?.stats?.clanId ?? s?.clanId ?? 0);
const partyOf = s => s?.party?.partyId || s?.partyId || null;
const near = (a, b, radius = 900) => a && b && Math.hypot(a.locX - b.locX, a.locY - b.locY) <= radius && Math.abs(a.locZ - b.locZ) <= 200;

class ClanWarDirector {
    constructor({ database, life, parties, clans, war, social, memory, personaFor, form, actions, updateDemand = () => {}, formationStatus = () => null,
        canWork = () => true, canContinue = () => true, now = Date.now }) {
        Object.assign(this, { database, life, parties, clans, war, social, memory, personaFor, form, actions, updateDemand, formationStatus, canWork, canContinue, now });
        this.states = new Map(); this.bySpot = new Map(); this.locations = new Map();
        this.plans = new Map(); this.autonomous = new Set(); this.cursor = 0; this.running = null; this.active = false;
        this.assemblyQueue = new Map(); this.assemblyCursor = 0; this.assemblyCandidates = [];
        this.assemblyChecks = new Map(); this.assemblyMetrics = { checks: 0, attempts: 0 };
    }
    index(state, id) {
        const prior = this.locations.get(id);
        if (prior) {
            this.bySpot.get(prior.spot)?.delete(id);
            if (!this.bySpot.get(prior.spot)?.size) this.bySpot.delete(prior.spot);
        }
        this.states.delete(id); this.locations.delete(id);
        if (!state) return;
        this.states.set(id, state);
        const spot = state.spotId;
        this.locations.set(id, { spot });
        if (spot) { if (!this.bySpot.has(spot)) this.bySpot.set(spot, new Set()); this.bySpot.get(spot).add(id); }
    }
    async start() {
        await this.war.refresh(true);
        const [rows, autonomous] = await Promise.all([this.database.fetchClanWarPlans(), this.database.execute([
            "SELECT clanId FROM clan_simulation_clans WHERE mode='autonomous'"])]);
        this.autonomous = new Set(autonomous.map(r => r.clanId));
        this.membershipRevision = this.clans.membershipRevision();
        rows.forEach(r => {
            const saved = JSON.parse(r.stateJson), { ceasefireUntil, ...plan } = saved;
            this.plans.set(r.clanId, { revision: r.revision, ...plan, ceasefires: Policy.ceasefires(saved, this.now()) });
        });
        this.active = true;
        this.unsubscribe = this.life.subscribePublications(packet => {
            if (!this.active) return;
            if (packet.kind === 'reset') { this.states.clear(); this.bySpot.clear(); this.locations.clear(); return; }
            const id = Number(packet.characterId); this.index(this.life.cachedState(id), id);
        }, { replay: true });
    }
    clearAssembly() { this.assemblyQueue.clear(); this.assemblyChecks.clear(); this.updateDemand([]); }
    stop() { this.active = false; this.unsubscribe?.(); this.clearAssembly(); }
    async save(clanId, state) {
        const previous = this.plans.get(clanId), { revision, ...json } = state;
        const result = await this.database.saveClanWarPlan(clanId, previous?.revision || 0, json);
        if (result.ok) this.plans.set(clanId, { ...json, revision: result.row.revision });
        return result.ok;
    }
    observe(clan, previous, at) {
        const sightings = new Map((previous || []).filter(r => at - r.at < Config.intelTtlMs).map(r => [`${r.enemyClanId}:${r.spotId}`, r]));
        const add = (observerId, enemyClanId, spotId, id, loc) => {
            if (!spotId || !enemyClanId || enemyClanId === clan.id) return;
            const key = `${enemyClanId}:${spotId}`, old = sightings.get(key), enemyIds = old?.at === at ? old.enemyIds : [];
            if (!enemyIds.includes(id)) enemyIds.push(id);
            sightings.set(key, { enemyClanId, spotId, at, observerId, loc: { ...loc }, enemyIds: enemyIds.slice(0, 18) });
        };
        for (const member of clan.members) {
            const source = this.states.get(member.id);
            if (source?.phase === 'hot') {
                const World = invoke('GameServer/World/World'), registered = World.registeredActorById(source.characterId);
                const actor = registered?.actor;
                if (!actor || actor.isDead?.() || actor.fetchIsOnline?.() === false) continue;
                const loc = { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
                if (utils.isInPeaceZone(loc.locX, loc.locY)) continue;
                for (const session of World.fetchVisibleUsers(registered.session, actor) || []) {
                    const target = session.actor, id = Number(target?.fetchId?.());
                    if (!target || target.isDead?.() || target.state?.fetchDead?.() || target.fetchIsOnline?.() === false) continue;
                    const there = { locX: target.fetchLocX(), locY: target.fetchLocY(), locZ: target.fetchLocZ() };
                    if (!near(loc, there)) continue;
                    const spotId = invoke('GameServer/Bot/AI/SpotService').findCurrentSpot(there)?.id
                        || session.coldLifeState?.spotId;
                    add(source.characterId, this.clans.clanOfMember(id)?.id, spotId, id, there);
                }
                continue;
            }
            if (!source || source.phase !== 'cold' || !(source.vitals?.hp > 0) || source.stats?.travel
                || utils.isInPeaceZone(source.loc.locX, source.loc.locY)) continue;
            for (const id of this.bySpot.get(source.spotId) || []) {
                const target = this.states.get(id), enemyClanId = this.clans.clanOfMember(id)?.id;
                if (!target || target.phase !== 'cold' || target.stats?.travel || !(target.vitals?.hp > 0)
                    || !enemyClanId || enemyClanId === clan.id || !near(source.loc, target.loc)) continue;
                add(source.characterId, enemyClanId, source.spotId, id, target.loc);
            }
        }
        const weight = sighting => (this.war.view.between(clan.id, sighting.enemyClanId).mutual ? 1000 : 0)
            + Number(this.social.indexes?.get(clan.id)?.get(`clan:${sighting.enemyClanId}`)?.hostility || 0);
        return [...sightings.values()].sort((a, b) => weight(b) - weight(a) || b.at - a.at).slice(0, 12);
    }
    ownMembers(clan, at) { return clan.members.map(m => this.states.get(m.id)).filter(s => Policy.available(s, at)); }
    actor(clan) { return { fetchId: () => clan.leaderId, fetchClanId: () => this.clans.clanOfMember(clan.leaderId)?.id || 0 }; }
    async review(clan, at) {
        // maintain() may have finished a fight since this pulse started.
        at = Math.max(at, this.now());
        const previous = this.plans.get(clan.id) || { revision: 0, intel: [] };
        if (at < Number(previous.nextReviewAt || 0)) return;
        const plan = { ...previous, ceasefires: Policy.ceasefires(previous, at),
            intel: this.observe(clan, previous.intel, at), nextReviewAt: at + Config.reviewMs };
        delete plan.ceasefireUntil;
        const members = this.ownMembers(clan, at), leader = this.states.get(clan.leaderId);
        const traits = this.personaFor(leader || { characterId: clan.leaderId })?.traits || {};
        const snapshot = this.social.clans.get(clan.id);
        const histories = (snapshot?.relations || []).filter(r => r.kind === 'character').flatMap(r => r.evidence || []);
        const relations = (snapshot?.relations || []).filter(r => r.kind === 'clan').map(row => ({ row,
            target: this.clans.findById(row.targetId), feeling: Policy.grievance({ ...row,
                evidence: [...(row.evidence || []), ...histories.filter(e => e.subjectClanId === row.targetId)] }, traits, at, Config) }))
            .filter(r => r.target).sort((a, b) => b.feeling.hostility - a.feeling.hostility);
        const currentTime = () => Math.max(at, this.now());
        const pressure = await this.database.fetchClanWarPressure?.(clan.id,
            () => currentTime() - Config.lossWindowMs, currentTime) || [];
        at = currentTime();
        plan.nextReviewAt = at + Config.reviewMs;
        plan.warPressure = pressure.filter(p => this.war.view.between(clan.id, p.enemyClanId).status !== 'neutral');
        plan.lossResponse = null;
        const readyMembers = clan.members.map(m => this.states.get(m.id)).filter(s => Policy.available(s, at, { allowHot: true })).length;
        const responses = new Map(plan.warPressure.map(p => [p.enemyClanId, Policy.lossResponse({ pressure: p, traits,
            members: clan.members.length, readyMembers, mutual: this.war.view.between(clan.id, p.enemyClanId).mutual })]));
        const incoming = this.war.view.all().filter(r => r.active && r.toClanId === clan.id && !this.war.view.between(clan.id, r.fromClanId).outgoing);
        let decision = null;
        for (const p of plan.warPressure.sort((a, b) => b.losses - a.losses)) {
            const action = responses.get(p.enemyClanId);
            if (!action) continue;
            const state = this.war.view.between(clan.id, p.enemyClanId);
            if (action === 'withdraw' && state.outgoing) {
                decision = { target: this.clans.findById(p.enemyClanId), action: 'withdraw', reason: 'war_casualties' };
                plan.lossResponse = { ...p, action, at, until: p.combatAt + Config.lossWindowMs }; break;
            }
            if (action === 'counterattack' && !plan.lossResponse) {
                plan.lossResponse = { ...p, action, at, until: p.combatAt + Config.lossWindowMs };
                plan.nextOperationAt = Math.min(Number(plan.nextOperationAt || at), at + Config.counterattackCooldownMs);
            }
        }
        if (!decision) for (const row of incoming) {
            if (!Policy.canDeclare(plan, row.fromClanId, at, row) || responses.get(row.fromClanId) === 'withdraw') continue;
            const target = this.clans.findById(row.fromClanId), feeling = relations.find(r => r.target.id === row.fromClanId)?.feeling;
            const sighting = plan.intel.find(r => r.enemyClanId === row.fromClanId);
            if (target && Policy.accepts({ traits, ownMembers: members.length, enemyMembers: sighting?.enemyIds.length || 0,
                hostility: feeling?.hostility || 0 })) {
                decision = { target, action: 'declare', reason: 'accept_war' }; break;
            }
        }
        if (!decision && members.length >= Config.minMembers) for (const entry of relations) {
            const state = this.war.view.between(clan.id, entry.target.id);
            if (!Policy.canDeclare(plan, entry.target.id, at) || !entry.feeling.ready || state.outgoing || responses.get(entry.target.id) === 'withdraw'
                || Rules.declaration({ ...clan, members: clan.members.length }, { ...entry.target, members: entry.target.members.length })) continue;
            decision = { target: entry.target, action: 'declare', reason: 'repeated_clan_aggression' }; break;
        }
        if (!decision) for (const row of this.war.view.all()) {
            if (!row.active || row.fromClanId !== clan.id || at - row.declaredAt < Config.reviewMs) continue;
            const feeling = relations.find(r => r.target.id === row.toClanId)?.feeling;
            const combatAt = Math.max(plan.combatAt?.[row.toClanId] || 0, this.war.combatAt(clan.id, row.toClanId),
                pressure.find(p => p.enemyClanId === row.toClanId)?.combatAt || 0);
            if (combatAt) plan.combatAt = { ...(plan.combatAt || {}), [row.toClanId]: combatAt };
            const quiet = at - Math.max(row.declaredAt, feeling?.lastHarmAt || 0, combatAt) >= Config.quietWithdrawMs;
            if (quiet) {
                decision = { target: this.clans.findById(row.toClanId), action: 'withdraw', reason: 'conflict_cooled' }; break;
            }
        }
        if (decision?.target && this.active && this.canWork()) {
            const result = await this.war.transition(this.actor(clan), decision.target.id, decision.action, { autonomous: true,
                expectedRevision: this.war.view.between(clan.id, decision.target.id).revision, reason: decision.reason,
                // Resource admission happened before queuing. The writer is
                // now busy with this command; only lifecycle/authority may revoke it.
                admit: () => this.active && Config.enabled && this.canContinue() && this.autonomous.has(clan.id) });
            plan.lastDecision = { at, targetClanId: decision.target.id, action: decision.action, reason: decision.reason,
                accepted: result.ok, code: result.code || null };
            if (result.ok && decision.action === 'withdraw') {
                const incoming = this.war.view.all().find(r => r.fromClanId === decision.target.id && r.toClanId === clan.id);
                plan.ceasefires[decision.target.id] = { until: at + Config.redeclareCooldownMs,
                    withdrawnAt: Math.max(at, Number(result.row?.updatedAt || 0)), incomingRevision: incoming?.revision || 0 };
                plan.defeats = 0; plan.lossResponse = null;
            }
        }
        await this.save(clan.id, plan);
    }
    operationCooldown(plan, enemyClanId, at) {
        return plan.lossResponse?.action === 'counterattack' && plan.lossResponse.enemyClanId === enemyClanId
            && plan.lossResponse.until > at ? Config.counterattackCooldownMs : Config.operationCooldownMs;
    }
    async setOperation(party, operation, spotId = null) {
        const result = await this.database.setClanWarPartyOperation(party.partyId, party.revision, operation, spotId);
        return result.ok ? this.parties.acceptRow(result.row) : null;
    }
    async maintain(party, at) {
        const op = party.stats.warOperation, hot = party.status === 'hot';
        const World = hot ? invoke('GameServer/World/World') : null;
        let members = party.memberIds.map(id => this.life.cachedState(id));
        if (!['active', 'hot'].includes(party.status) || members.some(s => !s || s.stats?.pvpEncounter || s.stats?.travel)) return;
        if (hot) {
            const actors = party.memberIds.map(id => World.registeredActorById(id));
            if (actors.some(r => !r?.actor || r.session?.pvpDefense || r.session?.pvpRevenge || r.session?.spotRelocation)) return;
            members = members.map((s, i) => ({ ...s, loc: { locX: actors[i].actor.fetchLocX(), locY: actors[i].actor.fetchLocY(), locZ: actors[i].actor.fetchLocZ() },
                vitals: { ...s.vitals, hp: actors[i].actor.fetchHp() }, stats: { ...s.stats, clanId: this.war.clanId(actors[i].actor) } }));
        }
        const ended = Policy.operationOutcome(op, members, this.war.view.between(op.clanId, op.enemyClanId), at);
        if (op.status === 'returning') {
            const homeLoc = Home.point(op);
            if (!homeLoc) return;
            // Repair old persisted orders once, using the same anchor as the
            // workers and visible actors. Mere timeout never completes a trip.
            if (!Home.same(op.homeLoc, homeLoc)) { await this.setOperation(party, { ...op, homeLoc }); return; }
            if (members.every(s => (hot || s.spotId === op.homeSpotId) && Home.reached(s.loc, homeLoc, 1200))) {
                await this.setOperation(party, null, op.homeSpotId);
            }
            return;
        }
        if (ended) {
            await this.setOperation(party, { ...op, status: 'returning', outcome: ended, expiresAt: at + Config.operationMs });
            const plan = this.plans.get(op.clanId) || { revision: 0, intel: [] };
            await this.save(op.clanId, { ...plan, nextOperationAt: at + this.operationCooldown(plan, op.enemyClanId, at),
                defeats: Number(plan.defeats || 0) + Number(ended === 'losses'), lastOperation: { id: op.id, at, outcome: ended } });
            return;
        }
        const leader = members.find(s => s.characterId === party.leaderId && s.vitals.hp > 0) || members.find(s => s.vitals.hp > 0);
        if (!leader || (!hot && leader.spotId !== op.targetSpotId) || hot && !near(leader.loc, op.targetLoc, 900)
            || !members.every(s => near(s.loc, leader.loc, 900))) return;
        if (hot && party.spotId !== op.targetSpotId) {
            await this.setOperation(party, { ...op, status: 'searching' }, op.targetSpotId); return;
        }
        const enemies = hot ? (World.fetchVisibleUsers(World.registeredActorById(leader.characterId)?.session,
            World.registeredActorById(leader.characterId)?.actor) || []).filter(s => s.actor && !s.actor.isDead?.()
                && this.war.clanId(s.actor) === op.enemyClanId
                && near(leader.loc, { locX: s.actor.fetchLocX(), locY: s.actor.fetchLocY(), locZ: s.actor.fetchLocZ() }))
            : [...(this.bySpot.get(leader.spotId) || [])].map(id => this.life.cachedState(id)).filter(s => s?.phase === 'cold'
                && s.vitals?.hp > 0 && !s.stats?.pvpEncounter && !s.stats?.travel && clanOf(s) === op.enemyClanId && near(leader.loc, s.loc));
        if (!enemies.length) {
            if (!op.clearSince) await this.setOperation(party, { ...op, status: 'holding', clearSince: at });
            else if (at - op.clearSince >= 60000) {
                await this.setOperation(party, { ...op, status: 'returning', outcome: 'spot_cleared', expiresAt: at + Config.operationMs });
                const plan = this.plans.get(op.clanId) || { revision: 0, intel: [] };
                await this.save(op.clanId, { ...plan, nextOperationAt: at + this.operationCooldown(plan, op.enemyClanId, at),
                    defeats: Math.max(0, Number(plan.defeats || 0) - 1), lastOperation: { id: op.id, at, outcome: 'spot_cleared' } });
            }
            return;
        }
        if (op.clearSince) { await this.setOperation(party, { ...op, status: 'engaging', clearSince: null }); return; }
        if (hot) return; // Visible combat belongs to the actors' native tactical ticks.
        const target = enemies[0], otherParty = partyOf(target) ? this.parties.find(partyOf(target)) : null;
        const ids = [...party.memberIds, ...(otherParty?.memberIds || [target.characterId])];
        if (ids.some(id => this.life.cachedState(id)?.phase !== 'cold')) return;
        await this.memory.ensureMany(ids);
        if (!this.active || !this.canWork()) return;
        const participant = s => { const p = partyOf(s) ? this.parties.find(partyOf(s)) : null;
            return { id: s.characterId, partyId: p?.partyId || null, size: p?.memberIds.length || 1,
                partyRevision: p?.revision, revision: s.simulation?.revision || 0, memoryRevision: this.memory.revision(s.characterId) }; };
        const result = await this.actions.apply({ key: `clan-war:${op.id}:${at}`, at, pressure: 3,
            action: 'clan_war', pvpIntent: true, spotId: leader.spotId, npcId: 0,
            actor: participant(this.life.cachedState(leader.characterId)), peer: participant(this.life.cachedState(target.characterId)) });
        this.lastCombat = { at, operationId: op.id, ok: result.ok, reason: result.reason, pvp: !!result.pvp };
        if (result.ok && result.pvp) {
            const plan = this.plans.get(op.clanId) || { revision: 0, intel: [] };
            await this.save(op.clanId, { ...plan, combatAt: { ...(plan.combatAt || {}), [op.enemyClanId]: at } });
        }
    }
    prepareAssembly(clan, plan, at, operations = this.parties.admitted().filter(p => p.stats?.warOperation)) {
        if (operations.length >= Config.maxActiveOperations) return { reason: 'operation_capacity' };
        if (operations.some(p => p.stats.warOperation.clanId === clan.id)) return { reason: 'operation_active' };
        if (at < Number(plan.nextOperationAt || 0)) return { reason: 'operation_cooldown' };
        const sightings = (plan.intel || []).filter(i => at - i.at < Config.intelTtlMs && this.war.view.between(clan.id, i.enemyClanId).mutual);
        const intel = (plan.lossResponse?.action === 'counterattack' && plan.lossResponse.until > at
            && sightings.find(i => i.enemyClanId === plan.lossResponse.enemyClanId)) || sightings[0];
        if (!intel) return { reason: 'no_fresh_intel' };
        const available = this.ownMembers(clan, at);
        const role = s => invoke('GameServer/Bot/AI/BotRoles').inferRole(s);
        const existing = this.parties.active().find(p => !p.stats?.warOperation && p.stats?.objective?.priority !== 'required'
            && !p.stats?.objective?.clanGoalKey && !p.stats?.objective?.helpDeal
            && p.memberIds.length >= Config.minMembers && p.memberIds.every(id => available.some(s => s.characterId === id))
            && p.memberIds.some(id => role(this.life.cachedState(id)) === 'healer')
            && p.memberIds.filter(id => !['healer', 'buffer'].includes(role(this.life.cachedState(id)))).length >= 2);
        const free = available.filter(s => !partyOf(s) && !invoke('GameServer/Bot/AI/BotServiceIdentity').isStaticService(s));
        const selected = existing ? existing.memberIds.map(id => this.life.cachedState(id))
            : Policy.roster(free, role, Config.minMembers, Config.maxMembers);
        if (selected.length < Config.minMembers || !selected.some(s => role(s) === 'healer')
            || selected.filter(s => !['healer', 'buffer'].includes(role(s))).length < 2) return { reason: 'roster_not_ready' };
        return { selected, existing, intel, available };
    }
    async assemble(clan, plan, at, ready = this.prepareAssembly(clan, plan, at)) {
        if (!ready.selected) return null;
        const { selected, existing, intel, available } = ready;
        const home = selected.find(s => s.characterId === existing?.leaderId) || selected[0];
        const op = { id: `${clan.id}:${at}`, clanId: clan.id, enemyClanId: intel.enemyClanId,
            kind: available.some(s => s.spotId === intel.spotId) ? 'defend_spot' : 'raid_farm', status: 'assembling',
            targetSpotId: intel.spotId, targetLoc: intel.loc, homeSpotId: home.spotId, homeLoc: { ...home.loc },
            observedAt: intel.at, observerId: intel.observerId, startedAt: at, expiresAt: at + Config.operationMs };
        op.homeLoc = Home.point(op);
        if (!op.homeLoc) return null;
        const party = existing ? await this.setOperation(existing, op) : await this.form(selected, op);
        if (party) await this.save(clan.id, { ...plan, nextOperationAt: at + this.operationCooldown(plan, intel.enemyClanId, at),
            lastOperation: { id: op.id, partyId: party.partyId, at, outcome: 'assembled' } });
        return party || null;
    }
    syncAssemblyDemand() {
        this.updateDemand([...this.assemblyQueue].filter(([, r]) => !r.existing).map(([id]) => id));
    }
    refreshAssembly(at) {
        const started = performance.now(); let checks = 0;
        const revision = `${this.war.view.revision}:${this.membershipRevision}`;
        if (this.assemblyRevision !== revision) {
            this.assemblyRevision = revision;
            this.assemblyCandidates = [...new Set(this.war.view.all().filter(r => r.active && this.war.view.hasMutual(r.fromClanId))
                .map(r => r.fromClanId))].filter(id => this.autonomous.has(id));
            const candidates = new Set(this.assemblyCandidates);
            for (const id of this.assemblyChecks.keys()) if (!candidates.has(id)) this.assemblyChecks.delete(id);
        }
        const operations = this.parties.admitted().filter(p => p.stats?.warOperation);
        const slots = Math.min(4, Math.max(0, Config.maxActiveOperations - operations.length));
        const check = id => {
            const clan = this.clans.findById(id), plan = this.plans.get(id) || {};
            const ready = clan && this.autonomous.has(id) && this.war.view.hasMutual(id)
                ? this.prepareAssembly(clan, plan, at, operations) : { reason: 'war_ended' };
            checks++;
            this.assemblyChecks.set(id, { clanId: id, checkedAt: at, reason: ready.reason || 'ready' });
            if (ready.reason) { this.assemblyQueue.delete(id); return; }
            const prior = this.assemblyQueue.get(id);
            if (!prior && this.assemblyQueue.size >= slots) return;
            this.assemblyQueue.set(id, { ...ready, clan, plan, queuedAt: prior?.queuedAt ?? at,
                reason: this.canWork() ? 'waiting_slot' : 'waiting_budget' });
        };
        const queued = new Set(this.assemblyQueue.keys());
        for (const id of queued) check(id); // At most the four operation slots.
        for (let n = 0; n < Math.min(4, this.assemblyCandidates.length); n++) {
            const id = this.assemblyCandidates[(this.assemblyCursor++) % this.assemblyCandidates.length];
            if (!queued.has(id)) check(id);
        }
        for (const id of [...this.assemblyQueue.keys()].slice(slots)) this.assemblyQueue.delete(id);
        this.syncAssemblyDemand();
        this.assemblyMetrics = { ...this.assemblyMetrics, checkedAt: at, checks, refreshMs: performance.now() - started };
    }
    async processAssembly(at) {
        const entry = this.assemblyQueue.entries().next().value;
        if (!entry || !this.active || !this.canWork()) return;
        const [id, request] = entry;
        request.reason = 'forming'; this.assemblyMetrics.attempts++;
        try {
            const party = await this.assemble(request.clan, request.plan, at, request);
            if (party) {
                this.assemblyQueue.delete(id);
                this.assemblyChecks.set(id, { clanId: id, checkedAt: at, reason: 'operation_active' });
            }
            else request.reason = this.formationStatus()?.clanId === id ? this.formationStatus().reason : 'formation_retry';
        } finally {
            // Stop/disable may have happened while the native membership writer ran.
            if (!this.active || !Config.enabled || !this.canContinue()) this.clearAssembly();
            else this.syncAssemblyDemand();
        }
    }
    pulse(at = this.now()) {
        if (!this.active || !Config.enabled || !this.canContinue()) { this.clearAssembly(); return this.running; }
        if (this.running) return this.running;
        // Cached, bounded readiness is independent of SQL/worker admission.
        // It must also revoke stale priority while heavier work is deferred.
        this.refreshAssembly(at);
        if (!this.canWork()) return null;
        this.running = (async () => {
            if (this.membershipRevision !== this.clans.membershipRevision()) {
                this.membershipRevision = this.clans.membershipRevision();
                const rows = await this.database.execute(["SELECT clanId FROM clan_simulation_clans WHERE mode='autonomous'"]);
                this.autonomous = new Set(rows.map(r => r.clanId));
                this.assemblyRevision = null;
                this.refreshAssembly(at);
            }
            await this.processAssembly(at); // One formation attempt, before diplomatic writes.
            for (const party of this.parties.admitted().filter(p => p.stats?.warOperation)) {
                if (!this.active || !this.canWork()) break;
                await this.maintain(party, at);
            }
            const clans = this.clans.all().filter(c => this.autonomous.has(c.id));
            for (let n = 0; n < Math.min(4, clans.length) && this.active && this.canWork(); n++) {
                const clan = clans[(this.cursor++) % clans.length];
                await this.review(clan, at);
            }
        })().finally(() => { this.running = null; });
        return this.running;
    }
    inspect() {
        return { active: this.active, policy: { hostilityThreshold: Config.hostilityThreshold, minHarmEpisodes: Config.minHarmEpisodes,
            quietWithdrawMs: Config.quietWithdrawMs, lossWindowMs: Config.lossWindowMs,
            operationCooldownMs: Config.operationCooldownMs, counterattackCooldownMs: Config.counterattackCooldownMs },
            plans: [...this.plans].map(([clanId, plan]) => ({ clanId, ...plan })), lastCombat: this.lastCombat,
            assembly: { ...this.assemblyMetrics, readiness: [...this.assemblyChecks.values()],
                queue: [...this.assemblyQueue].map(([clanId, r]) => ({ clanId, enemyClanId: r.intel.enemyClanId,
                    targetSpotId: r.intel.spotId, queuedAt: r.queuedAt, members: r.selected.length, reason: r.reason })) },
            operations: this.parties.admitted().filter(p => p.stats?.warOperation).map(p => {
                const hot = p.status === 'hot', members = p.memberIds.map(id => hot
                    ? invoke('GameServer/World/World').registeredActorById(id) : this.life.cachedState(id));
                const fighting = members.some(m => hot ? m?.session?.pvpDefense || m?.session?.pvpRevenge || m?.session?.pvpEncounter
                    : m?.stats?.pvpEncounter);
                const traveling = p.stats.travel || members.some(m => m?.session?.spotRelocation);
                const arrivals = members.map(m => Number(m?.session?.spotRelocation?.completesAt || 0));
                return { partyId: p.partyId, ...p.stats.warOperation, memberIds: p.memberIds, mode: hot ? 'hot' : 'cold',
                    phase: p.stats.warOperation.status === 'returning' ? 'returning' : fighting ? 'fighting'
                        : traveling ? 'traveling' : p.stats.warOperation.status,
                    livingMembers: members.every(m => hot ? m?.actor : m?.vitals)
                        ? members.filter(m => hot ? m.actor.fetchHp?.() > 0 : m.vitals.hp > 0).length : null,
                    arrivalAt: p.stats.travel?.arrivalAt || Math.max(0, ...arrivals) || null };
            }) };
    }
}
module.exports = { ClanWarDirector, near };
