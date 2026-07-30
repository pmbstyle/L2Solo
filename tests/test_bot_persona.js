const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');

const subject = { characterId: 2000123, stats: { generatedIndex: 987654 } };
const first = BotPersona.generate(subject);
const second = BotPersona.generate(subject);

assert.deepStrictEqual(first, second, 'the same generated seed must produce the exact same persona');
assert.deepStrictEqual(BotPersona.PRIMARY_DRIVES, ['progression', 'wealth', 'social'], 'the intentional drive model must not silently grow vague categories');
assert(BotPersona.PRIMARY_DRIVES.includes(first.primaryDrive), 'persona drive must stay inside the intentional three-drive model');
assert(first.textCard.includes('focused on'), 'every persona needs a compact model-facing text card');
BotPersona.TRAITS.forEach((trait) => {
    assert(Number.isFinite(first.traits[trait]), `${trait} must be numeric`);
    assert(first.traits[trait] >= 0 && first.traits[trait] <= 1, `${trait} must remain normalized`);
});

const originalExecute = Database.execute;
const statements = [];
try {
    BotPersona.reset();
    Database.execute = ([sql, params]) => {
        statements.push({ sql: String(sql), params });
        if (String(sql).startsWith('SELECT 1')) return Promise.resolve([]);
        if (String(sql).includes('FROM bot_personas WHERE characterId')) return Promise.resolve([]);
        if (String(sql).startsWith('INSERT INTO bot_personas')) return Promise.resolve({ affectedRows: 1 });
        return Promise.resolve([]);
    };

    BotPersona.ensure(subject).then((persona) => {
        assert.strictEqual(persona.seed, first.seed, 'persistence must retain the generated seed without mutation');
        assert.deepStrictEqual(persona.traits, first.traits, 'persistence must retain the seed-generated trait profile');
        const insert = statements.find((entry) => entry.sql.startsWith('INSERT INTO bot_personas'));
        assert(insert, 'a missing persona must be stored in its own durable table');
        assert.strictEqual(insert.params[2], '987654', 'generated population index must be the durable persona seed');
        assert.strictEqual(insert.params[3], persona.primaryDrive, 'primary drive must be queryable without parsing traits');
        assert.strictEqual(insert.params[4], persona.archetype, 'archetype must be queryable without parsing traits');
        const originalEnsure = BotPersona.ensure;
        BotPersona.reset();
        Database.execute = ([sql, params]) => {
            if (String(sql).startsWith('SELECT 1')) return Promise.resolve([]);
            if (String(sql).includes('FROM bot_life_state states')) {
                return Promise.resolve([{ characterId: 2000456, statsJson: '{"generatedIndex":456}' }]);
            }
            return Promise.resolve([]);
        };
        BotPersona.ensure = () => Promise.resolve(null);
        return BotPersona.backfillGenerated(100).then((backfill) => {
            assert.deepStrictEqual(backfill, { created: 0, exhausted: false }, 'a failed persona write must keep the migration eligible for retry');
            BotPersona.ensure = originalEnsure;
            console.log('Bot persona checks passed');
        });
    }).catch((err) => {
        console.error(err);
        process.exitCode = 1;
    }).finally(() => {
        Database.execute = originalExecute;
        BotPersona.reset();
    });
} catch (err) {
    Database.execute = originalExecute;
    BotPersona.reset();
    throw err;
}
