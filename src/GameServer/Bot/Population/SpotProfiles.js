const SpotService = invoke('GameServer/Bot/AI/SpotService');

function rewardForLevel(level) {
    const value = Math.max(1, Number(level || 1));
    return {
        exp: Math.round(value * 13),
        sp: Math.round(value * 2.2),
        adenaMin: Math.round(value * 2),
        adenaMax: Math.round(value * 7)
    };
}

function combatForLevel(level) {
    const value = Math.max(1, Number(level || 1));
    return {
        hp: Math.round(60 + value * 42),
        damage: Math.round(4 + value * 2.8),
        hitDelayMs: 1600
    };
}

function profileFromSpot(spot) {
    const avgLevel = Math.max(1, Math.round(spot.avgLevel || spot.minLevel || 1));

    return {
        id: spot.id,
        name: spot.name,
        center: { ...spot.center },
        minLevel: spot.minLevel,
        maxLevel: spot.maxLevel,
        avgLevel,
        density: spot.density,
        npcNames: [...(spot.npcNames || [])],
        rewards: rewardForLevel(avgLevel),
        mob: combatForLevel(avgLevel),
        risk: Math.max(0, avgLevel - spot.minLevel) + Math.max(0, 5 - Math.min(5, spot.density))
    };
}

const SpotProfiles = {
    cache: null,

    reset() {
        this.cache = null;
    },

    ensure() {
        if (this.cache) return this.cache;
        this.cache = SpotService.ensureIndexed().map(profileFromSpot);
        return this.cache;
    },

    findById(id) {
        return this.ensure().find((profile) => profile.id === id) || null;
    },

    findForState(state) {
        if (state?.spotId) {
            const existing = this.findById(state.spotId);
            if (existing) return existing;
        }

        const targetLevel = Number(String(state?.levelBand || '1').split('-')[0]) || 1;
        return this.ensure()
            .filter((profile) => profile.minLevel <= targetLevel + 4 && profile.maxLevel >= targetLevel - 4)
            .sort((a, b) => {
                const aGap = Math.abs(a.avgLevel - targetLevel);
                const bGap = Math.abs(b.avgLevel - targetLevel);
                if (aGap !== bGap) return aGap - bGap;
                return b.density - a.density;
            })[0] || this.ensure()[0] || null;
    }
};

module.exports = SpotProfiles;
