const EffectStore = invoke('GameServer/Effects/EffectStore');

function multiplier(actor, stat, fallback = 1) {
    return EffectStore.list(actor)
        .map((effect) => Number(effect.stats?.[stat]))
        .filter((value) => Number.isFinite(value))
        .reduce((total, value) => total * value, fallback);
}

function add(actor, stat, fallback = 0) {
    return EffectStore.list(actor)
        .map((effect) => Number(effect.stats?.[stat]))
        .filter((value) => Number.isFinite(value))
        .reduce((total, value) => total + value, fallback);
}

module.exports = {
    multiplier,
    add
};
