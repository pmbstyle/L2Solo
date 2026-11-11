'use strict';

const Policy = require('./OpportunisticRaidPolicy');
const Supply = require('./RaidSupplyPolicy');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Errands = require('./CombinedErrandPolicy');
const { yieldToLoop } = require('./RaidSearchWork');
const TIMEOUT_MS = 10 * 60 * 1000;

class RaidSupplyPreparation {
    constructor(deps) { Object.assign(this, deps); this.plans = new Map(); this.active = true; this.cursor = 0; }

    async start() {
        const groups = new Map();
        let scanned = 0;
        for (const state of this.life.populationSeedStates()) {
            if (++scanned % 16 === 0) await yieldToLoop();
            const marker = Supply.held(state);
            if (marker && marker.owner !== 'clan') { if (!groups.has(marker.id)) groups.set(marker.id, marker); }
        }
        for (const marker of groups.values()) {
            await this.memory.ensureMany?.(marker.memberIds);
            this.plans.set(marker.id, marker);
            if (!this.owns(marker)) await this.cancel(marker, 'raid_preparation_incomplete');
            await yieldToLoop();
        }
    }

    stop() { this.active = false; }
    snapshot() { return [...this.plans.values()].map(p => ({ id: p.id, bossId: p.objective.raidBossTemplateId,
        memberIds: p.memberIds, startedAt: p.startedAt, expiresAt: p.expiresAt })); }
    admitted() { return [...this.plans.values()].map(p => ({ stats: { objective: p.objective } })); }
    owns(plan) { return plan.memberIds.length === 9 && plan.memberIds.every(id =>
        this.life.cachedState(id)?.stats?.raidSupplyPreparation?.id === plan.id); }

    async fenced(ids, fn) {
        try {
            for (const id of ids) {
                if (!this.active || !(await this.coordinator.fenceBot(id)).ok) return null;
            }
            return this.active ? await fn() : null;
        } finally {
            for (const id of ids) this.coordinator.notifyState(this.life.cachedState(id));
        }
    }

    async reserve(members, objective, now = Date.now()) {
        const id = `raidprep_${now.toString(36)}_${members[0].characterId}`;
        const plan = { id, memberIds: members.map(s => s.characterId), startedAt: now,
            expiresAt: Math.min(objective.expiresAt, now + TIMEOUT_MS),
            objective: { ...objective, preparationId: id } };
        const quotes = new Map(), claimed = new Map();
        for (const s of objective.assessment.supplies || []) {
            if (!(s.missing > 0)) continue;
            const state = members.find(m => m.characterId === s.id), cash = Supply.cash(state);
            const quote = this.market.planPurchase(state, s.selfId, s.missing, { money: cash, purpose: 'raid_supply', claimed });
            if (!quote || quote.units < s.missing || !(quote.cost > 0) || !Number.isFinite(quote.cost)) return null;
            const trip = quote.trip ?? (Number.isFinite(quote.landed) ? quote.landed - quote.cost
                : this.market.tripFrom(state)(quote.town));
            const { priceCap, cashNeeded } = Supply.quoteBudget(quote, s.missing, trip);
            if (!(priceCap > 0) || !Number.isFinite(priceCap) || !Number.isFinite(cashNeeded) || cashNeeded > cash) return null;
            for (const { line, count } of quote.lines || []) {
                const key = `${line.recordId}:${line.lineId}`;
                const total = (claimed.get(key) || 0) + count;
                if (total > Number(line.count)) return null;
                claimed.set(key, total);
            }
            quotes.set(s.id, { selfId: s.selfId, target: s.target, priceCap, town: quote.town,
                cashNeeded });
            await yieldToLoop();
        }
        const saved = await this.fenced(plan.memberIds, async () => {
            const current = plan.memberIds.map(id => this.life.cachedState(id));
            if (current.some(s => !Policy.available(s, now) || !Policy.recruitLevelAllowed(s, objective.sourceLevel))
                || !Policy.composition(current).ready
                || !current.every((s, i) => current.slice(i + 1).every(peer => Policy.compatible(s, peer, this.memory.assess.bind(this.memory), now)))
                || current.some(s => objective.assessment.kits?.find(([id]) => id === s.characterId)?.[1]
                    !== Combat.kitEvents(s).join(':'))
                || current.some(s => quotes.has(s.characterId) && Supply.cash(s) < quotes.get(s.characterId).cashNeeded)) return null;
            // Partial reservations recover by releasing the incomplete plan.
            this.plans.set(id, plan);
            for (const state of current) {
                if (!this.active) return null;
                const result = await this.life.upsertState({ ...state, activity: 'party_wait',
                    stats: { ...state.stats, raidSupplyPreparation: { ...plan, supply: quotes.get(state.characterId) || null } },
                    timing: { ...state.timing, nextResolveAt: now + 30000 } }, 'raid_supply_reserved');
                if (!result || result.stats?.raidSupplyPreparation?.id !== id || result.party?.partyId) return null;
            }
            return plan;
        });
        if (!saved && this.plans.has(id)) await this.cancel(plan, 'raid_preparation_incomplete');
        return saved;
    }

    async cancel(plan, reason) {
        this.plans.delete(plan.id);
        for (const id of plan.memberIds) await this.fenced([id], async () => {
            const state = this.life.cachedState(id);
            if (state?.phase !== 'cold' || state.stats?.raidSupplyPreparation?.id !== plan.id) return;
            const kept = Errands.pending(state).filter(e => e.raidPreparationId !== plan.id);
            const next = Errands.withPending(state, kept);
            await this.life.upsertState({ ...next,
                activity: next.activity === 'party_wait' ? 'hunting' : next.activity,
                stats: { ...next.stats, raidSupplyPreparation: null },
                timing: { ...next.timing, nextResolveAt: Date.now() + 1000 } }, reason);
        });
        this.onReleased?.(plan.memberIds);
    }

    async maintain(now = Date.now()) {
        for (const plan of [...this.plans.values()]) {
            if (!this.active) return;
            const states = plan.memberIds.map(id => this.life.cachedState(id));
            if (!this.owns(plan) || now >= plan.expiresAt || states.some(s => s.phase !== 'cold'
                || s.party?.partyId || s.partyId || Policy.criminal(s) || Number(s.vitals?.hp) <= 0
                || !Policy.recruitLevelAllowed(s, plan.objective.sourceLevel))
                || !states.every((s, i) => states.slice(i + 1).every(peer => Policy.compatible(s, peer, this.memory.assess.bind(this.memory), now)))) {
                await this.cancel(plan, 'raid_preparation_cancelled'); continue;
            }
            let waiting = false;
            for (let offset = 0; offset < states.length; offset++) {
                const state = states[(offset + this.cursor) % states.length], marker = state.stats.raidSupplyPreparation;
                const supply = marker.supply;
                if (state.stats?.travel || state.stats?.tradeMeeting || ['traveling', 'shopping', 'merchant'].includes(state.activity)) {
                    waiting = true; continue;
                }
                if (!supply || Number(state.inventory?.[supply.selfId]?.amount || 0) >= supply.target) continue;
                waiting = true;
                const started = await this.fenced([state.characterId], async () => {
                    const latest = this.life.cachedState(state.characterId);
                    if (latest?.stats?.raidSupplyPreparation?.id !== plan.id || latest.stats?.tradeMeeting || latest.stats?.travel) return null;
                    const missing = Math.max(0, supply.target - Number(latest.inventory?.[supply.selfId]?.amount || 0));
                    if (!missing) return { supplied: true };
                    // The unit ceiling bounds each debit, not the total quote.
                    // Acquire prices the complete order and trip against this
                    // fresh wallet; native writers keep their own reserve checks.
                    return this.market.acquire(latest, supply.selfId, missing, {
                        purpose: 'raid_supply', raidPreparationId: plan.id, towns: [supply.town],
                        maxPrice: supply.priceCap, money: Supply.cash(latest) });
                });
                this.cursor = (this.cursor + 1) % 9;
                if (started?.supplied) return;
                if (!started?.plan || started.reason || !started.traveling && !started.bought && !started.pending)
                    await this.cancel(plan, 'raid_supplies_unavailable');
                return;
            }
            if (waiting || !this.plans.has(plan.id)) continue;
            const spot = this.catalog.findById(plan.objective.spotId);
            const check = await this.assess(states, spot, now);
            if (!this.active) return;
            if (!check.ready && /^(party_goal_|worker_|raid_assessment_unavailable)/.test(check.reason || '')) continue;
            const bossFree = check.ready ? this.bossFree(spot) : null;
            this.onAssessment?.({ at:now, id:plan.id, bossId:plan.objective.raidBossTemplateId,
                ready:check.ready, reason:check.reason, reasons:check.reasons || [], bossFree,
                ...(check.seconds === undefined ? {} : { seconds:check.seconds }),
                shortages:(check.shotPlans || []).filter(p => p.stock < p.required)
                    .map(({ id,selfId,stock,required }) => ({ id,selfId,stock,required })) });
            if (!check.ready || !bossFree) { await this.cancel(plan, 'raid_preparation_unavailable'); continue; }
            const party = await this.form(states, { ...plan.objective, assessment: check });
            if (party) this.plans.delete(plan.id);
        }
    }
}

module.exports = { RaidSupplyPreparation, TIMEOUT_MS };
