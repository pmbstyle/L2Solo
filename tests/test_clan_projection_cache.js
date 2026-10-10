const assert = require('assert');

require('../src/Global');

// The clan projection keeps each member's parsed stats and inventory between
// passes, keyed by the row text: an unchanged text gives the same parsed object,
// a changed text is parsed again even when simulationRevision did not move, and a
// member no projection has read for ten minutes is forgotten.
const Database = invoke('Database');
const Goals = invoke('GameServer/Clan/ClanGoalService');

function row(characterId, clanId, stats, inventory, revision = 1) {
    return {
        clanId, stateJson: '{}', name: `clan${clanId}`, level: 1, leaderId: 1,
        characterId, memberName: `m${characterId}`, memberTitle: '', classId: 0, memberLevel: 20, memberClanId: clanId,
        accountName: `a${characterId}`, activity: 'idle', phase: 'cold', adena: 0, currentRegion: '', spotId: null,
        locX: 0, locY: 0, locZ: 0, partyId: null, simulationOwner: 'cold_worker', simulationRevision: revision,
        inventorySummary: JSON.stringify(inventory), statsJson: JSON.stringify(stats),
        traitsJson: '{}', primaryDrive: null, archetype: null
    };
}

async function main() {
    let rows = [];
    const original = Database.execute;
    Database.execute = async () => rows.map((entry) => ({ ...entry }));
    try {
        const member = (clans, id) => clans.flatMap((clan) => clan.members).find((entry) => entry.characterId === id);
        rows = [row(1, 10, { role: 'dps' }, { 57: { amount: 5 } }), row(2, 10, { role: 'healer' }, {})];
        const first = await Goals.clanProjection();
        const second = await Goals.clanProjection();
        assert.strictEqual(member(second, 1).stats, member(first, 1).stats, 'an unchanged text reuses the parsed stats');
        assert.strictEqual(member(second, 1).inventory, member(first, 1).inventory, 'an unchanged text reuses the parsed inventory');
        assert.notStrictEqual(member(second, 1), member(first, 1), 'each pass builds its own member objects');

        rows = [row(1, 10, { role: 'tank' }, { 57: { amount: 7 } }), row(2, 10, { role: 'healer' }, {})];
        const changed = await Goals.clanProjection();
        assert.deepStrictEqual(member(changed, 1).stats, { role: 'tank' }, 'a new text under the same revision is parsed again');
        assert.deepStrictEqual(member(changed, 1).inventory, { 57: { amount: 7 } });
        assert.deepStrictEqual(member(first, 1).stats, { role: 'dps' }, 'an earlier pass keeps what it read');

        const single = await Goals.clanProjectionById(10);
        assert.strictEqual(member([single], 2).stats, member(changed, 2).stats, 'a one-clan pass shares the same entries');

        // Member 1 leaves; member 2's clan goes on acting. Ten minutes later the
        // next projection forgets member 1 and keeps member 2.
        const realNow = Date.now;
        try {
            const start = realNow();
            Date.now = () => start + 2 * 60 * 1000;
            rows = [row(2, 10, { role: 'healer' }, {})];
            const kept = member([await Goals.clanProjectionById(10)], 2).stats;
            Date.now = () => start + 11 * 60 * 1000;
            await Goals.clanProjectionById(10);
            rows = [row(1, 10, { role: 'tank' }, { 57: { amount: 7 } }), row(2, 10, { role: 'healer' }, {})];
            const back = await Goals.clanProjection();
            assert.notStrictEqual(member(back, 1).stats, member(changed, 1).stats, 'a member not projected for 10 minutes is forgotten');
            assert.deepStrictEqual(member(back, 1).stats, { role: 'tank' });
            assert.strictEqual(member(back, 2).stats, kept, 'a member still projected is kept');
        } finally {
            Date.now = realNow;
        }

        rows = [{ ...row(3, 11, {}, {}), statsJson: '{broken', inventorySummary: null }];
        const broken = await Goals.clanProjection();
        assert.deepStrictEqual(member(broken, 3).stats, {}, 'unreadable text still reads as empty');
        assert.deepStrictEqual(member(broken, 3).inventory, {});
    } finally {
        Database.execute = original;
    }
    console.log('clan projection cache tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
