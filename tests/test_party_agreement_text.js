const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Data = invoke('GameServer/DataCache');
const Agreement = invoke('GameServer/Bot/Population/PartyAgreement');
const Spot = invoke('GameServer/Bot/AI/SpotService');
const oldItems = Data.items, oldFind = Spot.findById;
try {
    Data.items = [{ selfId: 1867, template: { name: 'Karik Horn' } }];
    Spot.findById = id => id === 'cruma' ? { name: 'Cruma Tower' } : null;
    const goal = { itemId: 1867, spotId: 'cruma' };
    for (const mode of ['need', 'random', 'turn']) for (const help of [null, { itemId: 1867, fee: 30000 }]) {
        for (const target of [goal, { spotId: 'cruma' }, { spotId: '13_17' }, { itemId: 999999 }, null]) {
            const text = Agreement.describe(target, { mode, ...(help ? { help } : {}) });
            assert(!/-?\d+_-?\d+|item \d+/.test(text), text);
            assert(text.length <= 220, text);
            if (target?.itemId === 1867 || help) assert(text.includes('Karik Horn'));
            if (help) assert(text.includes('paying 30k'));
        }
    }
    assert.equal(Agreement.formationText('Beto', 'cruma', goal, { mode: 'turn' }),
        'Beto formed a party at Cruma Tower: farming Karik Horn, loot by turn.');
    for (const [fee, word] of [[30000, '30k'], [999999, '1kk'], [1250000, '1.3kk']]) {
        assert(Agreement.describe(goal, { help: { itemId: 1867, fee } }).includes(`paying ${word}`));
    }
    assert.equal(Agreement.describe({ itemId: 999999 }, null), '');
    console.log('Party journals use names and compact loot clauses');
} finally { Data.items = oldItems; Spot.findById = oldFind; }
