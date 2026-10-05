// One learning rule for personal estimates. Domain adapters supply the
// trait-derived starting error, floor and difficulty of the grade stage.
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

function knowledgeEnabled() {
    return Config.knowledgeErrorsEnabled !== false;
}

function learnedError(base, floor, points, halfLife) {
    const minimum = Math.max(0, Number(floor) || 0);
    const initial = Math.max(minimum, Number(base) || 0);
    if (!Number.isFinite(initial) || !Number.isFinite(minimum)) throw new RangeError('learning errors must be finite');
    const scale = Number(halfLife);
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('learning half-life must be positive');
    const experience = Math.max(0, Number(points) || 0);
    return minimum + (initial - minimum) * 0.5 ** (experience / scale);
}

module.exports = { knowledgeEnabled, learnedError };
