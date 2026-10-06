'use strict';

// A cold bot's wish network is built in the worker when it projects a
// resolve. Main then commits that state and needs the bot's decided activity
// (where to hunt, which mob, which improvement) for its next context, route
// and post-commit improvement. It reads the
// worker's decision made on exactly that state instead of building the
// network again on the main thread (L25). Kept in memory only, one entry per
// bot; a missing or older entry (a restart, a main-side change) falls back to
// building the network as before.

// What a decision depends on beyond updatedAt: a commit can merge clan or
// goal changes and a projection can change the class after the network was
// built, both keeping updatedAt; such a decision is not used.
function stateKey(state = {}) {
    const stats = state.stats || {};
    const plan = stats.equipmentPlan;
    return [Number(state.level || 0), Number(stats.classId || 0), state.activity || '', Number(stats.clanId || 0),
        plan ? `${plan.status || ''}:${Number(plan.target?.selfId || 0)}:${plan.clanGoal ? 1 : 0}` : ''].join('|');
}

// economy: the network built on `seen` (the state before the projection's
// last changes); state: the projected state main will commit.
function capture(economy, state, seen = state) {
    const leaf = economy?.network?.activity || null;
    return {
        updatedAt: Number(state?.updatedAt || 0),
        key: stateKey(seen),
        riskWeight: Number(economy?.riskWeight) || 0,
        activity: leaf ? {
            activity: leaf.activity || null,
            spotId: leaf.spotId ?? null,
            npcId: leaf.npcId ?? null,
            ...(leaf.activity === 'improving' && leaf.improvement ? { improvement: { ...leaf.improvement } } : {})
        } : null
    };
}

class ColdEconomyDecisions {
    constructor() {
        this.byId = new Map();
        this.hits = 0;
        this.misses = 0;
    }

    // committed: the commit's result. A commit that merged board deals or PK
    // drops into the bag keeps the worker's updatedAt, but the decision was
    // made on the bag before them: main builds the network itself then.
    accept(characterId, decision, committed = null) {
        const id = Number(characterId);
        if (!id) return;
        const bagChanged = !!committed?.settled || !!committed?.pkDrops?.length;
        if (decision && !bagChanged && Number.isFinite(Number(decision.updatedAt))) this.byId.set(id, decision);
        else this.byId.delete(id);
    }

    // The worker's decision made on exactly this state, or null. A workshop
    // crafter's network has production paths only on main: main decides.
    decided(state) {
        const id = Number(state?.characterId);
        const decision = this.byId.get(id);
        if (decision && decision.updatedAt === Number(state?.updatedAt || 0)
            && decision.key === stateKey(state) && !state.stats?.workshop?.entries?.length) {
            this.hits += 1;
            return decision;
        }
        if (decision) this.byId.delete(id);
        this.misses += 1;
        return null;
    }

    // The decided activity for this state, or build() when the worker has
    // not decided on exactly this state.
    activity(state, build) {
        const decision = this.decided(state);
        return decision ? decision.activity : build()?.network?.activity || null;
    }
}

module.exports = { capture, stateKey, ColdEconomyDecisions };
