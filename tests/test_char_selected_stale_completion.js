const assert = require('assert');

require('../src/Global');

const Shared         = invoke('GameServer/Network/Shared');
const ServerResponse = invoke('GameServer/Network/Response');
const charSelected   = invoke('GameServer/Network/Request/CharSelected');

const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
const original = {
    fetchCharacters: Shared.fetchCharacters,
    fetchClassInformation: Shared.fetchClassInformation,
    charSelected: ServerResponse.charSelected
};
const roster = [{ id: 1, name: 'First', classId: 0 }, { id: 2, name: 'Second', classId: 0 }];

// Each character list read waits until the test releases it.
const reads = [];
Shared.fetchCharacters = () => new Promise((resolve) => reads.push(() => resolve(roster)));
Shared.fetchClassInformation = () => Promise.resolve({ vitals: { maxHp: 100 } });
ServerResponse.charSelected = (actor) => ({ packet: 'CharSelected', id: actor.id });

function newSession() {
    return {
        accountId: 'fixture',
        socket: { destroyed: false },
        actor: null,
        selected: [],
        sent: [],
        setActor(properties) {
            this.actor = properties;
            this.selected.push(properties.id);
        },
        dataSendToMe(packet) {
            this.sent.push(packet);
        }
    };
}

function slot(index) {
    const packet = Buffer.alloc(5);
    packet[0] = 0x0d;
    packet.writeInt32LE(index, 1);
    return packet;
}

function release(order) {
    const pending = reads.splice(0);
    order.forEach((index) => pending[index]());
}

(async () => {
    try {
        {
            // Normal path: one selection creates its actor and tells the client.
            const session = newSession();
            charSelected(session, slot(1));
            release([0]);
            await settle();
            assert.deepStrictEqual(session.selected, [2], 'the selected character becomes the actor');
            assert.deepStrictEqual(session.sent, [{ packet: 'CharSelected', id: 2 }], 'the client is told once');
            assert.strictEqual(session.actor.name, 'Second');
            await charSelected(session, slot(0));
            assert.equal(reads.length, 0, 'a duplicate selection cannot start another load while an actor is attached');
            assert.deepStrictEqual(session.selected, [2]);
        }

        {
            // Two selections whose reads finish out of order: the newer one wins.
            const session = newSession();
            charSelected(session, slot(0));
            charSelected(session, slot(1));
            release([1, 0]);
            await settle();
            assert.deepStrictEqual(session.selected, [2], 'an older selection finishing last does not replace the newer one');
            assert.deepStrictEqual(session.sent, [{ packet: 'CharSelected', id: 2 }]);
        }

        {
            // Two selections finishing in order: only the newer one creates an actor.
            const session = newSession();
            charSelected(session, slot(0));
            charSelected(session, slot(1));
            release([0, 1]);
            await settle();
            assert.deepStrictEqual(session.selected, [2], 'a superseded selection creates no actor');
        }

        {
            // The connection closes while the list is read.
            const session = newSession();
            charSelected(session, slot(0));
            session.socket.destroyed = true;
            release([0]);
            await settle();
            assert.deepStrictEqual(session.selected, [], 'a closed connection gets no new actor');
            assert.deepStrictEqual(session.sent, [], 'nothing is sent to a closed connection');
        }

        assert.deepStrictEqual(unhandled, []);
        console.log('character selection stale completion ok');
    } finally {
        Object.assign(Shared, { fetchCharacters: original.fetchCharacters, fetchClassInformation: original.fetchClassInformation });
        ServerResponse.charSelected = original.charSelected;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
