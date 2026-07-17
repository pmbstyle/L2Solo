const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const macro = invoke('GameServer/Network/Request/Macro');
const macroList = invoke('GameServer/Network/Response/MacroList');

function writeD(value) {
    const data = Buffer.alloc(4);
    data.writeInt32LE(value);
    return data;
}

function writeS(value) {
    return Buffer.concat([Buffer.from(value, 'ucs2'), Buffer.alloc(2)]);
}

function makeMacroPacket(data) {
    const parts = [Buffer.from([0xc1]), writeD(data.id), writeS(data.name), writeS(data.descr), writeS(data.acronym), Buffer.from([data.icon, data.commands.length])];
    data.commands.forEach((command, index) => {
        parts.push(Buffer.from([index + 1, command.type]), writeD(command.d1), Buffer.from([command.d2]), writeS(command.command));
    });
    return Buffer.concat(parts);
}

async function main() {
    const original = {
        fetchMacros: Database.fetchMacros,
        setMacro: Database.setMacro,
        deleteMacro: Database.deleteMacro,
        deleteMacroShortcuts: Database.deleteMacroShortcuts
    };
    const stored = [];
    const deletedShortcuts = [];

    Database.fetchMacros = () => Promise.resolve(stored.map((entry) => ({ ...entry, commands: entry.commands.map((command) => ({ ...command })) })));
    Database.setMacro = (_, entry) => {
        const index = stored.findIndex((item) => item.id === entry.id);
        if (index >= 0) stored.splice(index, 1);
        stored.push({ ...entry, commands: entry.commands.map((command) => ({ ...command })) });
        return Promise.resolve();
    };
    Database.deleteMacro = (_, id) => {
        const index = stored.findIndex((entry) => entry.id === id);
        if (index >= 0) stored.splice(index, 1);
        return Promise.resolve();
    };
    Database.deleteMacroShortcuts = (_, id) => {
        deletedShortcuts.push(id);
        return Promise.resolve();
    };

    try {
        const packets = [];
        const session = {
            actor: { fetchId: () => 42 },
            dataSendToMe: (packet) => packets.push(packet)
        };
        const data = {
            id: 0,
            name: 'Assist',
            descr: 'Assist target',
            acronym: 'AST',
            icon: 3,
            commands: [
                { type: 1, d1: 1216, d2: 1, command: 'Greater Heal' },
                { type: 3, d1: 2, d2: 0, command: 'Attack' }
            ]
        };

        macro(session, makeMacroPacket(data));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(stored.length, 1, 'C1 must persist a macro');
        assert.strictEqual(stored[0].id, 1000, 'server must allocate the first macro id');
        assert.strictEqual(packets.length, 1, 'creation must synchronize the macro list');
        assert.strictEqual(packets[0][0], 0xe7, 'macro synchronization uses SendMacroList');
        assert.strictEqual(packets[0].readInt32LE(1), 1, 'first update starts revision one');
        assert.strictEqual(packets[0][6], 1, 'packet contains the total macro count');
        assert.strictEqual(packets[0][7], 1, 'packet contains the changed macro');
        assert.strictEqual(packets[0].readInt32LE(8), 1000, 'packet contains the allocated macro id');

        macro(session, Buffer.concat([Buffer.from([0xc2]), writeD(1000)]));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(stored.length, 0, 'C2 must remove the macro');
        assert.deepStrictEqual(deletedShortcuts, [1000], 'C2 must remove dependent macro shortcuts');
        assert.strictEqual(packets[1][0], 0xe7, 'deletion also synchronizes the list');
        assert.strictEqual(packets[1][6], 0, 'empty macro list reports zero macros');
        assert.strictEqual(packets[1][7], 0, 'empty macro list has no macro payload');

        const sync = macroList([{
            id: 1001, name: 'Test', descr: '', acronym: 'T', icon: 1,
            commands: [{ type: 4, d1: 2, d2: 3, command: 'Shortcut' }]
        }], 7);
        assert.strictEqual(sync.length, 1);
        assert.strictEqual(sync[0].readInt32LE(1), 7, 'response preserves the supplied revision');
        assert.strictEqual(sync[0][28], 1, 'response serializes the macro icon after its strings');
    } finally {
        Object.assign(Database, original);
    }
}

main().then(() => console.log('Macro tests passed'));
