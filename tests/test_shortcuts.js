const assert = require('assert');
require('../src/Global');

const Database = invoke('Database');
const register = invoke('GameServer/Network/Request/AddShortcut');
const init = invoke('GameServer/Network/Response/ShortcutInit');
const { refreshSkills } = invoke('GameServer/Shortcuts');

function fields(packet, offset, count) {
    return Array.from({ length: count }, (_, i) => packet.readInt32LE(offset + i * 4));
}

async function main() {
    const original = {
        deleteShortcut: Database.deleteShortcut,
        setShortcut: Database.setShortcut,
        fetchShortcuts: Database.fetchShortcuts
    };
    let level = 40;
    const skillset = { fetchSkill: id => id === 92 ? {
        fetchLevel: () => level, fetchPassive: () => false
    } : id === 999 ? { fetchPassive: () => true } : undefined };
    const stored = [];
    const packets = [];
    const session = {
        actor: { fetchId: () => 42, skillset },
        dataSendToMe: packet => packets.push(packet)
    };
    Database.deleteShortcut = async (_, slot) => {
        const index = stored.findIndex(row => row.slot === slot);
        if (index >= 0) stored.splice(index, 1);
    };
    Database.setShortcut = async (_, row) => stored.push({ ...row });
    Database.fetchShortcuts = async () => stored.map(row => ({ ...row }));
    const request = (kind, slot, id) => {
        const buffer = Buffer.alloc(17);
        buffer[0] = 0x33;
        [kind, slot, id, 1].forEach((value, i) => buffer.writeInt32LE(value, 1 + i * 4));
        return register(session, buffer);
    };
    try {
        await request(2, 13, 92);
        assert.equal(packets[0][0], 0x44);
        assert.deepStrictEqual(fields(packets[0], 1, 5), [2, 13, 92, 40, 1]);
        for (const kind of [1, 3, 4, 5]) {
            await request(kind, kind + 20, 123);
            assert.deepStrictEqual(fields(packets.at(-1), 1, 4), [kind, kind + 20, 123, 1]);
        }
        const login = init(await Database.fetchShortcuts(), skillset);
        assert.equal(login[0], 0x45);
        assert.equal(login.readInt32LE(1), 5);
        assert.deepStrictEqual(fields(login, 5, 5), [2, 13, 92, 40, 1]);
        for (let i = 0; i < 4; i++) {
            assert.deepStrictEqual(fields(login, 25 + i * 16, 4), [i === 0 ? 1 : i + 2, stored[i + 1].slot, 123, 1]);
        }
        const count = packets.length;
        await request(2, 13, 998);
        await request(2, 13, 999);
        assert.equal(packets.length, count, 'unknown/passive skills must not replace a slot');
        assert.equal(stored[0].id, 92);
        level = 41;
        await refreshSkills(session, session.actor);
        assert.equal(packets.length, count + 1, 'only skill slots need refreshing');
        assert.deepStrictEqual(fields(packets.at(-1), 1, 5), [2, 13, 92, 41, 1]);
        assert.equal(init(stored, skillset).readInt32LE(17), 41, 'login resolves current level from legacy rows');
        await refreshSkills({ ...session, accountId: 'bot_42' }, session.actor);
        assert.equal(packets.length, count + 1);
        console.log('Shortcut packet and skill refresh tests passed');
    } finally {
        Object.assign(Database, original);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
