'use strict';

// A cold bot's wish network is built in the worker when it projects a
// resolve. Main then commits that state and needs the bot's decided activity
// (where to hunt, which mob, which improvement) for its next context, route
// and post-commit improvement. It reads the
// worker's decision made on exactly that state instead of building the
// network again on the main thread (L25). Kept in memory only, one entry per
// bot; a missing or older entry (a restart, a main-side change) falls back to
// building the network as before.

function capture(economy, state) {
    const leaf = economy?.network?.activity || null;
    return {
        updatedAt: Number(state?.updatedAt || 0),
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

    // The worker's decision made on exactly this state, or null.
    decided(state) {
        const id = Number(state?.characterId);
        const decision = this.byId.get(id);
        if (decision && decision.updatedAt === Number(state?.updatedAt || 0)) {
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

module.exports = { capture, ColdEconomyDecisions };
