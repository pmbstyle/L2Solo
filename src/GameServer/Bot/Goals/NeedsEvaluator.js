function percentage(value, maximum) {
    const max = Math.max(1, Number(maximum) || 0);
    return Math.max(0, Math.min(1, Number(value) / max));
}

function routePlan(state, spot) {
    return {
        kind: state.party?.partyId ? 'party_route' : 'farm_route',
        routeId: spot?.route?.id || state.stats?.route?.id || null,
        spotId: spot?.id || state.spotId || null,
        expectedBenefit: 'experience_and_sp',
        risk: Number(spot?.risk || 0)
    };
}

function evaluate(state = {}, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const spot = options.spot || null;
    const level = Math.max(1, Number(state.level || 1));
    const hpPct = percentage(state.vitals?.hp, state.vitals?.maxHp);
    const mpPct = percentage(state.vitals?.mp, state.vitals?.maxMp);
    const candidates = [];

    if (state.activity === 'dead' || hpPct <= 0.05) {
        candidates.push({
            type: 'recover',
            priority: 100,
            target: { condition: 'alive_and_recovered' },
            plan: { kind: 'town_return', expectedBenefit: 'safe_recovery', risk: 0 },
            blockers: [],
            nextReviewAt: timestamp + 60000
        });
        return candidates;
    }

    if (hpPct < 0.35 || mpPct < 0.2 || state.activity === 'resting') {
        candidates.push({
            type: 'recover',
            priority: 90,
            target: { hpPct: 0.8, mpPct: 0.65 },
            plan: { kind: 'rest', expectedBenefit: 'restore_vitals', risk: 0 },
            blockers: [],
            nextReviewAt: timestamp + 60000
        });
    }

    const minimumAdena = Math.max(120, level * 120);
    if (Number(state.adena || 0) < minimumAdena) {
        candidates.push({
            type: 'earn_adena',
            priority: 65,
            target: { adena: minimumAdena },
            plan: { ...routePlan(state, spot), expectedBenefit: 'adena_and_loot' },
            blockers: spot ? [] : ['missing_spot'],
            nextReviewAt: timestamp + 8 * 60 * 1000
        });
    }

    candidates.push({
        type: 'progress_level',
        priority: 35,
        target: { level: level + 1 },
        plan: routePlan(state, spot),
        blockers: spot ? [] : ['missing_spot'],
        nextReviewAt: timestamp + 12 * 60 * 1000
    });

    return candidates;
}

module.exports = { evaluate };
