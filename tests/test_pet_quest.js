const assert = require('assert');
require('../src/Global');
const originalInvoke = global.invoke;
const inventory = new Map();
const service = {
    completeWolfQuest: async state => { inventory.set(2375, (inventory.get(2375) || 0) + 1); inventory.delete(3417); await state.exit(true); },
    giveItem: async (_, id, amount) => inventory.set(id, (inventory.get(id) || 0) + amount),
    takeItem: async (_, id, amount = 1) => {
        if ((inventory.get(id) || 0) < amount) return false;
        inventory.set(id, inventory.get(id) - amount); return true;
    },
    questDropAmount: (amount, needed, current) => Math.min(amount, needed - current)
};
global.invoke = name => name === 'GameServer/Quest/QuestService' ? service : originalInvoke(name);
const quest = require('../src/GameServer/Quest/quests/Q419_GetAPet');
const { questions } = require('../data/Pets/c4-wolf-quiz.json');
let level = 14, race = 0;
const state = {
    state: 'created', variables: {}, session: { actor: { fetchLevel: () => level, fetchRace: () => race,
        backpack: { fetchItemFromSelfId: id => ({ fetchAmount: () => inventory.get(id) || 0 }) } } },
    get(name, fallback) { return this.variables[name] ?? fallback; },
    getInt(name) { return Number(this.variables[name]) || 0; },
    async set(name, value) { this.variables[name] = value; },
    async setState(value) { this.state = value; },
    isStarted() { return this.state === 'started'; },
    isCompleted() { return this.state === 'completed'; },
    async exit() { this.state = 'created'; this.variables = {}; }, playSound() {}
};
async function main() {
    assert.strictEqual(await quest.onEvent(state, 'start'), null);
    level = 15;
    await quest.onEvent(state, 'start');
    assert.strictEqual(inventory.get(3418), 1);
    await quest.onKill(state, { fetchSelfId: () => 460 });
    assert.strictEqual(inventory.get(3423), undefined, 'wrong race target gives no progress');
    for (let i = 0; i < 55; i++) await quest.onKill(state, { fetchSelfId: () => 103 });
    assert.strictEqual(inventory.get(3423), 50);
    await quest.onEvent(state, 'proof');
    assert.strictEqual(state.getInt('cond'), 2);
    assert.strictEqual(await quest.onEvent(state, 'quiz'), null, 'visits required');
    for (const id of [7256,7091,7072]) await quest.onEvent(state, `learn_${id}`);
    await quest.onEvent(state, 'quiz');
    let quiz = JSON.parse(state.get('quiz'));
    assert.strictEqual(new Set(quiz).size, 10);
    const first = questions.find(q => q.id === quiz[0]);
    await quest.onEvent(state, `answer_0_${first.id}_${first.answers.findIndex(a => !a.correct)}`);
    assert.strictEqual(state.getInt('cond'), 2);
    assert.strictEqual(state.getInt('visits'), 0, 'failed exam resets visits');
    for (const id of [7256,7091,7072]) await quest.onEvent(state, `learn_${id}`);
    await quest.onEvent(state, 'quiz');
    quiz = JSON.parse(state.get('quiz'));
    assert.strictEqual(await quest.onEvent(state, 'right'), null, 'no generic client success bypass');
    for (let i = 0; i < 10; i++) {
        const question = questions.find(q => q.id === quiz[i]);
        const answer = `answer_${i}_${question.id}_${question.answers.findIndex(a => a.correct)}`;
        await quest.onEvent(state, answer);
        assert.strictEqual(await quest.onEvent(state, answer), null, 'repeated/stale answer cannot advance or duplicate reward');
    }
    assert.strictEqual(inventory.get(2375), 1);
    assert.strictEqual(state.state, 'created', 'quest is repeatable');
    for (const [file, minimum] of [['Q042_HelpTheUncle',25],['Q043_HelpTheSister',26],['Q044_HelpTheSon',24]]) {
        const baby = require(`../src/GameServer/Quest/quests/${file}`);
        state.state = 'created'; level = minimum - 1;
        assert.strictEqual(await baby.onEvent(state, 'start'), null);
        level = minimum;
        assert(await baby.onEvent(state, 'start'), 'minimum baby quest level is inclusive');
    }
    console.log('Wolf quest race, collection, tutor, exam, replay and baby level gates passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.invoke = originalInvoke; });
