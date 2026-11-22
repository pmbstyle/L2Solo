const assert = require('node:assert/strict');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Knowledge = invoke('GameServer/Bot/AI/BotDialogueKnowledge');

function actor(id, name, x, z = 0, extra = {}) {
    return {
        fetchId: () => id, fetchName: () => name, fetchLocX: () => x,
        fetchLocY: () => 0, fetchLocZ: () => z, fetchIsOnline: () => true,
        fetchLevel: () => 20, isDead: () => false, ...extra
    };
}

function mob(id, name, x, extra) {
    return actor(id, name, x, 0, { fetchAttackable: () => true, ...extra });
}

async function main() {
    const old = { users: World.fetchVisibleUsers, npcs: World.fetchNpcsInRadius,
        actor: World.registeredActorById, sight: Geodata.hasLineOfSight, world: World.user };
    const ally = { actor: actor(10, 'PartyLeader', 150) };
    const bot = { actor: actor(20, 'Observer', 0), accountId: 'bot_observer',
        partyCompanion: true, followPlayerSession: ally };
    const aggressor = { actor: actor(11, 'Aggressor', 400) };
    const oldAggressor = { actor: actor(12, 'OldAggressor', 450) };
    const flagged = { actor: actor(13, 'FlaggedBystander', 500, 0, { fetchPvpFlag: () => 1, fetchKarma: () => 100 }) };
    const peer = { actor: actor(14, 'AnotherBot', 700), accountId: 'bot_peer' };
    const otherFloor = { actor: actor(15, 'OtherFloor', 300, 400) };
    const blocked = { actor: actor(16, 'BehindWall', 650) };
    const far = { actor: actor(17, 'DistantSpeaker', 2600) };
    const staging = { actor: actor(18, 'StagingBot', 200), populationStaging: true };
    const now = Date.now();
    ally.pvpAggressors = new Map([[11, { at: now, victimId: 10 }], [12, { at: now - 60000, victimId: 10 }]]);
    const users = [ally, bot, aggressor, oldAggressor, flagged, peer, otherFloor, blocked, far, staging];
    const npcs = [
        mob(30, 'Wolf', 200, { fetchDestId: () => 20 }), mob(31, 'Wolf', 260),
        mob(32, 'Orc', 350, { fetchHostile: () => true }),
        mob(33, 'Party Add', 420, { fetchDestId: () => 10 }),
        mob(34, 'Hidden Ogre', 650, { fetchDestId: () => 20 }),
        mob(35, 'Corpse', 250, { isDead: () => true }),
        mob(36, 'Vendor', 250, { fetchAttackable: () => false }),
        mob(37, 'Pet', 255, { fetchIsPet: () => true }),
        mob(38, 'Raid Boss', 900, { fetchIsRaidBoss: () => true })
    ];

    const look = (session = bot) => Knowledge.execute({ action: 'look_around' }, { session, playerSession: far });
    let checked = 0;
    try {
        World.user = { sessions: users };
        World.fetchVisibleUsers = (_session, observer) => {
            assert.equal(observer, bot.actor);
            return users.filter(session => session !== bot);
        };
        World.registeredActorById = id => users.find(session => session.actor.fetchId() === id);
        World.fetchNpcsInRadius = () => npcs;
        Geodata.hasLineOfSight = (_x, _y, _z, targetX, _targetY, targetZ) => {
            checked++;
            return targetX !== 650 && targetZ === 0;
        };
        const view = await look();
        assert.equal(view.ok, true);
        assert.deepEqual(view.people.map(row => row.name).sort(),
            ['Aggressor', 'AnotherBot', 'FlaggedBystander', 'OldAggressor', 'PartyLeader'].sort());
        assert.equal(view.people.find(row => row.name === 'AnotherBot').kind, 'bot');
        assert.deepEqual(view.mobs.find(row => row.name === 'Wolf'),
            { name: 'Wolf', level: 20, raidBoss: false, hostile: false, count: 2, nearest: 200 });
        assert.deepEqual(view.mobs.map(row => row.name), ['Wolf', 'Orc', 'Party Add', 'Raid Boss']);
        assert.equal(view.mobs.at(-1).raidBoss, true);
        assert.equal(view.danger, 'confirmed');
        assert.deepEqual(view.threats.map(row => [row.name, row.evidence]), [
            ['Wolf', 'targeting_you'], ['Aggressor', 'recently_attacked_your_party'], ['Party Add', 'targeting_your_party']
        ]);
        assert(ally.pvpAggressors.has(12), 'observing does not prune combat state');
        assert(!JSON.stringify(view).includes('DistantSpeaker'), 'chat address does not grant visibility');
        assert(Knowledge.actionsFor(bot).includes('look_around'));

        checked = 0;
        const cold = { characterId: 20, loc: { locX: 0, locY: 0, locZ: 0 } };
        assert(!Knowledge.actionsFor(cold).includes('look_around'));
        assert.deepEqual(await look(cold), { ok: false, reason: 'local_view_unavailable' });
        assert.equal(checked, 0, 'saved positions never trigger a live scan');

        ally.pvpAggressors.clear();
        World.fetchNpcsInRadius = () => [
            ...Array.from({ length: 40 }, (_, index) => mob(100 + index, `Orc ${index}`, 50 + index)),
            mob(300, 'Incoming', 2300, { fetchDestId: () => 20 })
        ];
        const crowded = await look();
        assert(checked <= 48, 'line-of-sight work is bounded even in dense encounters');
        assert(crowded.limited && crowded.mobs.length <= 6);
        assert.deepEqual(crowded.threats.map(row => row.name), ['Incoming'], 'nearby scenery does not hide a known visible attacker');

        World.fetchNpcsInRadius = () => [npcs[2]];
        const safeView = await look();
        assert.equal(safeView.danger, 'none_seen');
        assert.deepEqual(safeView.threats, []);
    } finally {
        World.fetchVisibleUsers = old.users; World.fetchNpcsInRadius = old.npcs; World.registeredActorById = old.actor;
        Geodata.hasLineOfSight = old.sight; World.user = old.world;
    }
    console.log('Local observation covers live visibility, observed threats, and bounded read-only work');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
