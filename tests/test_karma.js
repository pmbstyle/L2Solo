const assert = require('assert');

require('../src/Global');

const Karma = invoke('GameServer/Karma');

function actor({ pk = 0, level = 1, karma = 0 } = {}) {
    return {
        fetchPk: () => pk,
        fetchLevel: () => level,
        fetchKarma: () => karma
    };
}

assert.strictEqual(Karma.pkKillKarma(actor({ pk: 0, level: 40 }), actor({ level: 40 })), 240, 'first PK should award sourced minimum karma');
assert.strictEqual(Karma.pkKillKarma(actor({ pk: 4, level: 60 }), actor({ level: 20 })), 1440, 'PK karma must scale with prior PK count and level advantage');
assert.strictEqual(Karma.karmaLostForExperience(actor({ karma: 1000 }), 520), 2, 'earned experience should wash karma using the C4 XP divider');
assert.strictEqual(Karma.karmaLostForExperience(actor({ karma: 1 }), 520), 1, 'karma wash must not make karma negative');
assert.strictEqual(Karma.closesTowns(1), true, 'any karma keeps a character out of towns');
assert.strictEqual(Karma.closesTowns(0), false, 'no karma leaves towns open');
assert.strictEqual(Karma.closesTowns(undefined), false, 'a missing karma value leaves towns open');

console.log('Karma regression checks passed');
