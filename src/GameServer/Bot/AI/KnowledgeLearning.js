// One lifelong learning curve for prices, usefulness, mobs, people and crafts.
// Grade difficulty is a fraction of x1 C4 kills; neither rates nor content cap
// change it. Rare economic actions use the same fixed point unit in every grade.
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');

const STAGES = Object.freeze([
    ['none', 1, 20], ['d', 20, 40], ['c', 40, 52],
    ['b', 52, 61], ['a', 61, 76], ['s', 76, 79]
].map(Object.freeze));
const STAGE_KILL_FRACTION = 0.25;
// Rare trade/craft experience is counted in own deals, independently of the
// thousands of kills in a later grade's hunting curriculum.
const FIRST_ECONOMIC_HALF_LIFE = 3;
let stageRows = null;
let byGrade = null;

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

// Built once after DataCache, before board startup; lazy access also supports
// standalone readers. Six rows, each with x1 stage kills and their learning N.
function stages() {
    if (stageRows) return stageRows;
    if (!Array.isArray(DataCache.experience) || DataCache.experience.length < 79
        || !Array.isArray(DataCache.npcs) || !DataCache.npcs.length) {
        throw new Error('knowledge_game_data_not_ready');
    }
    const rewards = new Map(), seen = new Set();
    for (const npc of DataCache.npcs) {
        if (seen.has(npc.selfId)) continue;
        seen.add(npc.selfId);
        const level = Number(npc.template?.level);
        const reward = Formulas.calcAcquiredExp(level, Number(npc.rewards?.exp));
        if (npc.template?.kind !== 'Monster' || npc.raidBoss || npc.template.raidBoss
            || !Number.isInteger(level) || level < 1 || level > 78 || !Number.isFinite(reward) || reward <= 0) continue;
        if (!rewards.has(level)) rewards.set(level, []);
        rewards.get(level).push(reward);
    }
    const perKill = new Map();
    for (const [level, values] of rewards) {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        perKill.set(level, values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
    }
    let previousN = 0;
    const rows = STAGES.map(([grade, minLevel, endLevel]) => {
        let kills = 0;
        for (let level = minLevel; level < endLevel; level++) {
            const exp = Number(DataCache.experience[level]) - Number(DataCache.experience[level - 1]);
            const reward = perKill.get(level);
            if (!Number.isFinite(exp) || exp <= 0 || !(reward > 0)) {
                throw new Error(`knowledge_grade_data_missing:${level}`);
            }
            kills += exp / reward;
        }
        // Narrow bands need not have more raw kills than their predecessor.
        // Preserve the authored increasing difficulty, with no per-bot tuning.
        const halfLife = Math.max(previousN + 1, Math.ceil(kills * STAGE_KILL_FRACTION));
        previousN = halfLife;
        return Object.freeze({ grade, minLevel, maxLevel: endLevel - 1, kills: Math.ceil(kills), halfLife });
    });
    byGrade = Object.freeze(Object.fromEntries(rows.map(row => [row.grade, row])));
    stageRows = Object.freeze(rows);
    return stageRows;
}

function gradeOfLevel(level) {
    const value = Math.max(1, Number(level) || 1);
    for (let i = STAGES.length - 1; i >= 0; i--) if (value >= STAGES[i][1]) return STAGES[i][0];
    return 'none';
}

function halfLifeOf(grade, domain = 'mobs') {
    stages();
    const stage = byGrade[String(grade).toLowerCase()];
    if (!stage) throw new RangeError('unknown_learning_grade');
    if (domain === 'mobs' || domain === 'people') return stage.halfLife;
    if (domain === 'market' || domain === 'crafting') {
        return FIRST_ECONOMIC_HALF_LIFE;
    }
    throw new RangeError('unknown_learning_domain');
}

// Points stay lifelong in the caller's own domain. Domain adapters derive the
// trait base/floor; the shared switch gates estimates AND event increments.
function stageError(base, floor, points, grade, domain = 'mobs') {
    return learnedError(base, floor, points, halfLifeOf(grade, domain));
}

module.exports = { knowledgeEnabled, learnedError, stages, gradeOfLevel, halfLifeOf, stageError,
    STAGE_KILL_FRACTION, FIRST_ECONOMIC_HALF_LIFE };
