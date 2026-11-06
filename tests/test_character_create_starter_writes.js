const assert = require('assert');

require('../src/Global');

const Database       = invoke('Database');
const DataCache      = invoke('GameServer/DataCache');
const Shared         = invoke('GameServer/Network/Shared');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const ServerResponse = invoke('GameServer/Network/Response');
const createNewChar  = invoke('GameServer/Network/Request/CreateNewChar');

// On Node 22 an unhandled rejection ends the server; record it instead.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

const SUCCESS = ServerResponse.charCreateSuccess()[0];
const FAIL    = ServerResponse.charCreateFail(0x00)[0];

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

const saved = {
    Database: { ...Database },
    Shared: { ...Shared },
    ensureCharacterStock: ShotStock.ensureCharacterStock,
    DataCache: {
        newbieSpawns: DataCache.newbieSpawns,
        newbieItems: DataCache.newbieItems,
        newbieShortcuts: DataCache.newbieShortcuts,
        items: DataCache.items,
        fetchSkillTreeFromClassId: DataCache.fetchSkillTreeFromClassId,
        fetchSkillFromSelfId: DataCache.fetchSkillFromSelfId
    }
};

// One starter skill, item and shortcut for class 0.
DataCache.newbieSpawns    = [{ classId: 0, spawns: [{ locX: 0, locY: 0, locZ: 0 }] }];
DataCache.newbieItems     = [{ classId: 0, items: [{ selfId: 57, amount: 1 }] }];
DataCache.newbieShortcuts = [{ classId: 0, shortcuts: [{ id: 3, kind: 3, slot: 0 }] }];
DataCache.items           = [];
DataCache.fetchSkillTreeFromClassId = (classId, callback) => callback({
    skills: [{ selfId: 1177, name: 'Wind Strike', levels: [{ pLevel: 1, level: 1 }] }]
});
DataCache.fetchSkillFromSelfId = (selfId, callback) => callback({ template: { passive: false } });
Shared.fetchClassInformation = () => Promise.resolve({ vitals: { maxHp: 100, maxMp: 50 } });

function fixture(failing) {
    const events = [];
    const write = (kind) => () => {
        events.push(kind);
        return failing === kind ? Promise.reject(new Error(`injected ${kind} failure`)) : Promise.resolve();
    };
    Database.fetchCharacterName = () => Promise.resolve([]);
    Database.createCharacter = () => Promise.resolve({ insertId: 5 });
    Database.setSkill = write('skill');
    Database.setItem = write('item');
    Database.setShortcut = write('shortcut');
    ShotStock.ensureCharacterStock = () => { events.push('shots'); return Promise.resolve(); };
    Shared.fetchCharacters = () => Promise.resolve([{ id: 5, name: 'Starter' }]);
    Shared.enterCharacterHall = () => events.push('hall');
    const session = {
        accountId: 'fixture',
        dataSendToMe(packet) {
            events.push(packet[0] === SUCCESS ? 'success' : packet[0] === FAIL ? 'fail' : `0x${packet[0].toString(16)}`);
        }
    };
    return { session, events };
}

function packet(name) {
    const parts = [Buffer.from([0x0b]), Buffer.from(name, 'ucs2'), Buffer.alloc(2)];
    for (let i = 0; i < 12; i++) parts.push(Buffer.alloc(4));
    return Buffer.concat(parts);
}

(async () => {
    try {
        {
            // Normal path: the starter kit is written, then success, then the hall.
            const { session, events } = fixture(null);
            createNewChar(session, packet('Starter'));
            await settle();
            assert.deepStrictEqual(events, ['skill', 'item', 'shots', 'shortcut', 'success', 'hall'],
                'success and the character hall follow the starter writes');
        }
        {
            // One starter rule for a player's and a bot's creation: the template's
            // slot, worn as the table marks it, a shield beside a worn two-handed
            // weapon kept in the bag; the rows are copies, the table keeps its marks.
            const written = [];
            DataCache.items = [{ selfId: 9001, etc: { slot: 14 }, template: { kind: 'Weapon.Bow' } },
                { selfId: 9002, etc: { slot: 8 }, template: { kind: 'Armor.Shield' } }];
            DataCache.newbieItems = [{ classId: 0, items: [{ selfId: 57, amount: 1 }, { selfId: 1835, amount: 9, equipped: false },
                { selfId: 9001, amount: 1, equipped: true }, { selfId: 9002, amount: 1, equipped: true }] }];
            const before = structuredClone(DataCache.newbieItems);
            const { session } = fixture(null);
            Database.setItem = (id, item) => { written.push(item); return Promise.resolve(); };
            createNewChar(session, packet('Starter'));
            await settle();
            await invoke('GameServer/Bot/BotManager').awardBaseGear(6, 0);
            assert.deepStrictEqual(DataCache.newbieItems, before, 'the newbie table is not edited by a creation');
            const rows = [[57, 0, false], [1835, 0, false], [9001, 14, true], [9002, 8, false]];
            assert.deepStrictEqual(written.map(item => [item.selfId, item.slot, item.equipped]), [...rows, ...rows],
                'a player and a bot start with the same worn rows');
            DataCache.items = [];
        }
        // A failed starter write is a failed creation, not a success followed
        // by an unobserved rejection.
        for (const failing of ['skill', 'item', 'shortcut']) {
            const { session, events } = fixture(failing);
            createNewChar(session, packet('Starter'));
            await settle();
            assert.ok(!events.includes('success'), `no success after a failed ${failing} write`);
            assert.strictEqual(events[events.length - 1], 'fail', `a failed ${failing} write is reported as a failed creation`);
            assert.deepStrictEqual(unhandled, [], `the failed ${failing} write is observed`);
        }

        console.log('character creation starter writes ok');
    } finally {
        Object.assign(Database, saved.Database);
        Object.assign(Shared, saved.Shared);
        ShotStock.ensureCharacterStock = saved.ensureCharacterStock;
        Object.assign(DataCache, saved.DataCache);
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
