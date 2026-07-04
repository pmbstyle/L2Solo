const PRESETS = {
    x1: { label: 'x1', multiplier: 1 },
    x10: { label: 'x10', multiplier: 10 },
    x50: { label: 'x50', multiplier: 50 }
};

function numberOr(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizePreset(value) {
    const key = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PRESETS, key) ? key : 'x1';
}

function selectedPreset() {
    return normalizePreset(process.env.L2NODE_PROGRESSION_RATE || options.default.General?.progressionPreset);
}

function profile() {
    const preset = PRESETS[selectedPreset()];
    const general = options.default.General || {};
    const multiplier = preset.multiplier;

    return {
        preset: preset.label,
        multiplier,
        exp: numberOr(general.expRate, 1) * multiplier,
        sp: numberOr(general.spRate ?? general.expRate, 1) * multiplier,
        adena: numberOr(general.adenaRate, 1) * multiplier,
        drop: numberOr(general.dropChanceRate, 1) * multiplier,
        spoil: numberOr(general.spoilRate ?? general.dropChanceRate, 1) * multiplier
    };
}

function groupRate(group, kind = 'drop') {
    const current = profile();
    const hasAdena = (group.items || []).some((item) => Number(item.selfId) === 57);
    if (hasAdena) return current.adena;
    return kind === 'spoil' ? current.spoil : current.drop;
}

function rollGroup(overall, rate, rng = Math.random) {
    const scaled = Math.max(0, Number(overall) || 0) * numberOr(rate, 1);
    const chance = Math.min(100, scaled);

    return {
        hit: chance > 0 && rng() * 100 <= chance,
        amountMultiplier: Math.max(1, scaled / 100)
    };
}

function scaleAmount(amount, amountMultiplier, rng = Math.random) {
    const scaled = Math.max(0, Number(amount) || 0) * Math.max(1, Number(amountMultiplier) || 1);
    const whole = Math.floor(scaled);
    const fraction = scaled - whole;
    return Math.max(1, whole + (rng() < fraction ? 1 : 0));
}

module.exports = {
    PRESETS,
    normalizePreset,
    selectedPreset,
    profile,
    groupRate,
    rollGroup,
    scaleAmount
};
