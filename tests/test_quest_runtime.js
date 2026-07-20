const assert = require('assert');

require('../src/Global');

const QuestService = invoke('GameServer/Quest/QuestService');
const Q001 = require('../src/GameServer/Quest/quests/Q001_LettersOfLove');
const Q002 = require('../src/GameServer/Quest/quests/Q002_WhatWomenWant');
const Q003 = require('../src/GameServer/Quest/quests/Q003_WillTheSealBeBroken');

async function main() {
    assert.strictEqual(Q001.eventNpc('start'), 7048);
    assert.strictEqual(Q002.eventNpc('reward'), 7223);
    assert.strictEqual(Q003.eventNpc('start'), 7141);
    assert.strictEqual(Q002.eventNpc('unknown'), null);

    const session = {};
    const order = [];
    let releaseFirst;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const first = QuestService.mutate(session, async () => {
        order.push('first-start');
        markStarted();
        await new Promise((resolve) => { releaseFirst = resolve; });
        order.push('first-end');
    });
    const second = QuestService.mutate(session, async () => { order.push('second'); });
    await started;
    assert.deepStrictEqual(order, ['first-start'], 'the second quest mutation must wait for the first');
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ['first-start', 'first-end', 'second']);

    const state = {
        session: {
            actor: {
                backpack: { fetchItemFromSelfId: () => null }
            }
        },
        isCompleted: () => false,
        isStarted: () => true,
        getInt: () => 2
    };
    const html = await Q003.onTalk(state, { fetchSelfId: () => 7141 });
    assert.match(html, /all three ritual ingredients/, 'Q003 must not reward a player whose hand-in items disappeared');
}

main().then(() => console.log('quest runtime checks passed')).catch((error) => {
    console.error(error);
    process.exit(1);
});
