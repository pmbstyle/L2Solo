const assert = require('assert');
const EventEmitter = require('events');

require('../src/Global');

const Server = require('../src/Server');
const Session = invoke('GameServer/Session');
const Shared = invoke('GameServer/Network/Shared');

// Nothing may reach the process-wide rejection path: on Node 22 it ends the
// whole server. Record instead of exiting so each case can be asserted.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

function frame(payload) {
    const result = Buffer.alloc(payload.length + 2);
    result.writeUInt16LE(result.length, 0);
    Buffer.from(payload).copy(result, 2);
    return result;
}

function fakeSocket() {
    const socket = new EventEmitter();
    socket.remoteAddress = '127.0.0.1';
    socket.remotePort = 1;
    socket.destroyed = false;
    socket.written = [];
    socket.write = (data) => socket.written.push(data);
    socket.destroy = () => { socket.destroyed = true; };
    return socket;
}

// A real game session behind the real connection wiring: the packet goes
// through Session.dataReceive and the opcode table to the real handler.
function connectGame(accountId) {
    const socket = fakeSocket();
    let session;
    Server.prototype.onSocket.call({ name: 'Test', callback: (value) => {
        session = new Session(value);
        session.accountId = accountId;
        return session;
    } }, socket);
    return { socket, session };
}

function slotPacket(opcode, slot) {
    const payload = Buffer.alloc(5);
    payload[0] = opcode;
    payload.writeInt32LE(slot, 1);
    return frame(payload);
}

// The real connection wiring, without opening a listening port.
function connect(dataReceive) {
    const socket = fakeSocket();
    const session = { received: [], dataReceive, error() {} };
    Server.prototype.onSocket.call({ name: 'Test', callback: () => session }, socket);
    return { socket, session };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
    {
        // L84: a handler throws on the first packet of a chunk; the second
        // packet of the same chunk must not reach the dropped session.
        const { socket, session } = connect(function (packet) {
            this.received.push(packet[2]);
            if (packet[2] === 0x01) throw new Error('bad packet');
        });

        socket.emit('data', Buffer.concat([frame([0x01]), frame([0x02])]));

        assert.deepStrictEqual(session.received, [0x01], 'no packet is dispatched after the connection was dropped');
        assert.strictEqual(socket.destroyed, true, 'the failing connection is dropped');
    }

    {
        // Normal path: every packet of a chunk is still dispatched.
        const { socket, session } = connect(function (packet) {
            this.received.push(packet[2]);
        });

        socket.emit('data', Buffer.concat([frame([0x01]), frame([0x02])]));

        assert.deepStrictEqual(session.received, [0x01, 0x02], 'healthy packets of one chunk are all dispatched');
        assert.strictEqual(socket.destroyed, false);
    }

    {
        // L85: a handler that fails through its returned Promise costs the
        // connection, like a synchronous throw, instead of the process.
        const { socket } = connect(() => Promise.reject(new Error('late failure')));

        socket.emit('data', frame([0x01]));
        await settle();

        assert.strictEqual(socket.destroyed, true, 'a rejected handler drops its connection');
        assert.deepStrictEqual(unhandled, [], 'the rejection is observed at the boundary');
    }

    {
        // Normal path: a handler that resolves later keeps its connection.
        const { socket } = connect(() => Promise.resolve('done'));

        socket.emit('data', frame([0x01]));
        await settle();

        assert.strictEqual(socket.destroyed, false, 'a resolved handler keeps its connection');
    }

    const fetchCharacters = Shared.fetchCharacters;
    try {
        // A character slot the account does not have: the real handlers read
        // a missing character inside their nested chain.
        Shared.fetchCharacters = () => Promise.resolve([{ id: 1, name: 'Only', classId: 0 }]);
        for (const [name, opcode] of [['CharSelected', 0x0d], ['CharDelete', 0x0c]]) {
            const { socket } = connectGame('fixture');
            socket.emit('data', slotPacket(opcode, 9));
            await settle();
            await settle();

            assert.strictEqual(socket.destroyed, true, `${name} with a bad slot drops the connection`);
            assert.deepStrictEqual(unhandled, [], `${name} returns its nested chain to the boundary`);
        }

        // A character list read that fails after the return to selection.
        Shared.fetchCharacters = () => Promise.reject(new Error('injected list failure'));
        {
            const { socket } = connectGame('fixture');
            socket.emit('data', frame([0x46]));
            await settle();
            await settle();

            assert.strictEqual(socket.destroyed, true, 'Restart with a failed list read drops the connection');
            assert.deepStrictEqual(unhandled, [], 'Restart returns its list chain to the boundary');
        }
    } finally {
        Shared.fetchCharacters = fetchCharacters;
    }

    // EnterWorld logs its own failure and keeps the player connected (author's rule).
    {
        const ShotStock = invoke('GameServer/Inventory/ShotStock');
        const HennaService = invoke('GameServer/Henna/HennaService');
        const Database = invoke('Database');
        const saved = [HennaService.restore, Database.fetchMacros, Database.fetchShortcuts];
        HennaService.restore = () => Promise.resolve();
        Database.fetchMacros = () => Promise.resolve([]);
        Database.fetchShortcuts = () => Promise.resolve([]);
        try {
            const enterWorld = invoke('GameServer/Network/Request/EnterWorld');
            const socket = fakeSocket();
            const session = {
                actor: { backpack: { fetchItems: () => [] }, fetchId: () => 1, fetchName: () => 'p',
                    enterWorld: () => Promise.reject(new Error('injected world entry failure')) },
                dataSendToMe() {},
                dataReceive(packet) { return enterWorld(this, packet); },
                error() {}
            };
            Server.prototype.onSocket.call({ name: 'Test', callback: () => session }, socket);
            socket.emit('data', frame([0x03]));
            await new Promise((resolve) => setTimeout(resolve, 100));

            assert.strictEqual(socket.destroyed, false, 'a failed world entry is logged and keeps the connection');
        } finally {
            [HennaService.restore, Database.fetchMacros, Database.fetchShortcuts] = saved;
        }
    }

    await settle();
    assert.deepStrictEqual(unhandled, [], 'no rejection escapes the connection boundary');
    console.log('packet dispatch failure handling ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
