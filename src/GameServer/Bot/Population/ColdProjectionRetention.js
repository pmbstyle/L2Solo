'use strict';

const { createHash } = require('node:crypto');

function partyStamp(party) {
    return party ? createHash('sha256').update(JSON.stringify(party)).digest('hex') : null;
}

function stateStamp(state) {
    const simulation = state.simulation || {};
    const timing = state.timing || {};
    const loc = state.loc || {};
    const vitals = state.vitals || {};
    return [state.phase, state.activity, state.updatedAt, state.spotId, state.currentRegion, state.homeRegion,
        state.level, state.exp, state.sp, state.adena, state.levelBand, state.stats?.karma,
        simulation.ownerId, simulation.revision, simulation.leaseId, simulation.leaseUntil,
        timing.activityStartedAt, timing.nextResolveAt, timing.lastResolvedAt, timing.lastHotAt,
        vitals.hp, vitals.maxHp, vitals.mp, vitals.maxMp,
        loc.locX, loc.locY, loc.locZ, state.inventory, state.stats, state.vitals, state.party];
}

function same(left, right) {
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function contextStamp(context) {
    const pressure = context.pressure || {};
    return [context.spot, context.interactionMemory, context.clanHallServices,
        pressure.expMultiplier, pressure.deathChanceMultiplier, pressure.directorReason,
        context.buyOrderEscrow, context.targetNpcId, context.isPartyLeader, context.party,
        context.partyMembers, context.route];
}

// Replay only a producer's existing intent. The provider reads current local
// dependencies; it never plans, hydrates or obtains global context views.
class ColdProjectionRetention {
    constructor({ stateFor, dependencies, epoch }) {
        this.stateFor = stateFor;
        this.dependencies = dependencies;
        this.epoch = epoch;
        this.reset();
    }

    reset() {
        this.entries = new WeakMap();
        this.prepared = new WeakMap();
        this.dirty = new WeakMap();
    }

    invalidate(state) {
        if (state && typeof state === 'object') this.dirty.set(state, (this.dirty.get(state) || 0) + 1);
    }

    prepare(state, context, partyGeneration) {
        if (this.stateFor(state?.characterId) !== state || !context) return;
        const members = context.party ? (context.party.memberIds || []).map(id => this.stateFor(id)) : [];
        if (members.some(member => !member)) return;
        const stamp = this.dependencies(state, context);
        this.prepared.set(context, {
            state, context, epoch: this.epoch(), stamp, partyGeneration,
            contextStamp: contextStamp(context),
            own: stateStamp(state), sequence: this.dirty.get(state) || 0,
            partyStamp: partyStamp(context.party),
            members: members.map(member => ({ state: member, stamp: stateStamp(member), sequence: this.dirty.get(member) || 0 }))
        });
    }

    remember(entry) {
        const prepared = this.prepared.get(entry?.context);
        if (!prepared || prepared.state !== entry.state || this.stateFor(entry.state.characterId) !== entry.state) return false;
        this.entries.set(entry.state, { ...prepared, entry });
        return true;
    }

    get(characterId) {
        const unavailable = reason => ({ ok: false, reason });
        if (!Number.isSafeInteger(characterId) || characterId <= 0) return unavailable('invalid_character');
        const state = this.stateFor(characterId);
        if (!state) return unavailable('missing_state');
        const record = this.entries.get(state);
        if (!record) return unavailable('missing_projection');
        if (!record.epoch || record.epoch !== this.epoch()) return unavailable('projection_epoch_changed');
        if (state.phase !== 'cold' || !same(record.own, stateStamp(state))) return unavailable('projection_state_changed');
        if (record.sequence !== (this.dirty.get(state) || 0)) return unavailable('projection_dirty');
        const context = record.context;
        if (!same(record.contextStamp, contextStamp(context))) return unavailable('projection_context_changed');
        if (context.route) return unavailable('dynamic_route_context');
        if (context.spot?.raidBoss) return unavailable('dynamic_raid_context');
        const current = this.dependencies(state, context);
        if (record.partyGeneration !== current.partyGeneration) return unavailable('party_generation_changed');
        if (current.clanId || context.clanHallServices) return unavailable('dynamic_clan_hall_context');
        if (record.stamp.catalog !== current.catalog || record.stamp.physicalCatalog !== current.physicalCatalog) {
            return unavailable('spot_catalog_changed');
        }
        if (!same(record.stamp.pressure, current.pressure)) return unavailable('pressure_changed');
        if (record.stamp.memory !== current.memory || record.stamp.memoryRevision !== current.memoryRevision) return unavailable('memory_changed');
        if (context.buyOrderEscrow !== current.escrow) return unavailable('escrow_changed');
        if (context.targetNpcId !== current.targetNpcId) return unavailable('target_changed');
        if (context.party && (context.party !== current.party || record.partyStamp !== partyStamp(current.party))) {
            return unavailable('party_context_changed');
        }
        for (const member of record.members) {
            if (this.stateFor(member.state.characterId) !== member.state || !same(member.stamp, stateStamp(member.state))
                || member.sequence !== (this.dirty.get(member.state) || 0)) return unavailable('party_member_changed');
        }
        return { ok: true, entry: record.entry };
    }
}

module.exports = { ColdProjectionRetention };
