'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const oldKnowledge = Config.knowledgeErrorsEnabled;
Config.knowledgeErrorsEnabled = false;
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const state = { characterId: 990121, level: 50, adena: 3000, stats: { classId: 2, money: [3719, 0.0001, 1000, 900000] } };
const persona = { traits: {}, understanding: 0.5 };
const saved = { value: Table.value, best: Table.best, income: Hunt.huntIncome, samples: Hunt.sampledRows };
try {
    const rows = { near: { exp: 234195, adena: 30000, loot: 8294, kills: 10, deaths: 0 },
        middle: { exp: 112756, adena: 13000, loot: 2941, kills: 10, deaths: 0 },
        grey: { exp: 40270, adena: 3000, loot: 719, kills: 10, deaths: 0 } };
    Table.value = id => rows[id] || null;
    Hunt.huntIncome = () => ({ perHour: 3719, expPerHour: 40270 });
    Hunt.sampledRows = () => [];
    const money = Economics.create(state, { persona, deathHours: 0, moneyWeight: 1 });
    const experience = Economics.create(state, { persona, deathHours: 0, moneyWeight: 0 });
    for (const id of Object.keys(rows)) {
        close(money({ id }).valueHours, (rows[id].adena + rows[id].loot) / 3719);
        close(experience({ id }).valueHours, rows[id].exp / 40270);
    }
    assert(money({ id: 'near' }).valueHours > 10.2 && money({ id: 'middle' }).valueHours > 4.2);
    assert.equal(Economics.moneyWeight({ ...state, stats: { money: [3719, 1, 0, 900000], wishFocus: [1, 0, 5000] }, adena: 10000 }), 1);
    for (const stats of [{ money: [3719, 1, 0, 0] }, {}, { wishFocus: [1, 0, 0] },
        { wishFocus: [1, 0, null] }, { wishFocus: [1, 0, Infinity] }, { wishFocus: [1, 0, 3000] }]) {
        assert.equal(Economics.moneyWeight({ ...state, stats }), 0);
    }
    assert.equal(Economics.moneyWeight({ ...state, stats: { wishFocus: [1, 0, 900000] } }), 1);
    Table.best = () => ({ adena: 6000, loot: 4000 });
    Hunt.huntIncome = () => ({ perHour: 0, expPerHour: 40270 });
    const unsampled = Economics.create({ ...state, stats: { classId: 2, wishFocus: [1, 0, 900000] } },
        { persona, deathHours: 0 });
    close(unsampled({ id: 'near' }).valueHours, 38294 / 10000);
    Table.best = () => null;
    close(Economics.create({ ...state, stats: { classId: 2 } }, { persona, deathHours: 0, moneyWeight: 1 })({ id: 'grey' }).valueHours, 3719);
} finally {
    Table.value = saved.value; Table.best = saved.best; Hunt.huntIncome = saved.income; Hunt.sampledRows = saved.samples;
    Config.knowledgeErrorsEnabled = oldKnowledge;
}
console.log('PASS saved money gap, unfunded-focus fallback and shared spot-value units');
