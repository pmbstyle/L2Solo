const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Data = invoke('GameServer/DataCache');
const Agreement = invoke('GameServer/Bot/Population/PartyAgreement');
const Recruit = invoke('GameServer/Bot/Population/ColdPartyRecruitmentChat');
const Persona = invoke('GameServer/Bot/AI/PersonaPartyDecisionPolicy');
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
    const shout = (roles, maxSize, objective, agreement) => Recruit.recruitmentText({
        leaderId: 1, spotId: 'cruma', stats: { objective, agreement }
    }, roles.map((role, index) => ({ characterId: index + 1, level: 40, party: { role } })), null, maxSize);
    assert.equal(shout(['tank', 'buffer', 'dps'], 4, null, { mode: 'random' }),
        'LF healer, Cruma Tower lv40, loot random');
    assert.equal(shout(['tank', 'dps'], 4, goal, { mode: 'need' }),
        'LF healer/buffer, Cruma Tower lv40, farming Karik Horn, loot by need');
    assert.equal(shout(['tank', 'healer', 'buffer'], 4, goal, { mode: 'turn', help: { itemId: 1867, fee: 30000 } }),
        'LF dps, Cruma Tower lv40, need help farming Karik Horn, paying 30k, loot by turn');
    assert.equal(Persona.reply({ accept: true, goal }), 'ok, farming Karik Horn in Cruma Tower');
    assert.equal(Persona.reply({ accept: true, goal: { spotId: 'cruma' } }), 'ok, heading to Cruma Tower');
    assert.equal(Agreement.formationText('Beto', 'cruma', goal, { mode: 'turn' }),
        'Beto formed a party at Cruma Tower: farming Karik Horn, loot by turn.');
    for (const [fee, word] of [[30000, '30k'], [999999, '1kk'], [1250000, '1.3kk']]) {
        assert(Agreement.describe(goal, { help: { itemId: 1867, fee } }).includes(`paying ${word}`));
    }
    assert.equal(Agreement.describe({ itemId: 999999 }, null), '');
    Data.items = [{ selfId: 1867, template: { name: 'Long item '.repeat(40).trim() } }];
    const longShout = shout(['tank', 'buffer', 'dps'], 4, goal, { mode: 'need' });
    assert.equal(longShout, 'LF healer, Cruma Tower lv40, loot by need');
    console.log('Party shouts, player replies and journals use names and compact loot clauses');
} finally { Data.items = oldItems; Spot.findById = oldFind; }
