// Prices and usefulness share market understanding and the grade curriculum.
// The caller gates personal estimates with the common knowledge switch; native
// board settlement gates its +1 experience using that same synchronous hook.
const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');

const ERROR_FLOOR = 0.03;
const TRAIT_ERROR = 0.17;

function errorOf(understanding, ownCounterDeals, counterKey = 'material none') {
    const value = Number(understanding);
    const understood = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.3;
    const grade = String(counterKey).split(' ').at(-1);
    return Learning.stageError(ERROR_FLOOR + TRAIT_ERROR * (1 - understood), ERROR_FLOOR,
        ownCounterDeals, grade, 'market');
}

module.exports = { knowledgeEnabled: Learning.knowledgeEnabled, errorOf, ERROR_FLOOR };
