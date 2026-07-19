const assert = require('assert');
const Server = require('../src/Server');

function packet(payload) {
    const result = Buffer.alloc(payload.length + 2);
    result.writeUInt16LE(result.length, 0);
    payload.copy(result, 2);
    return result;
}

{
    const received = [];
    const receive = Server.packetReceiver((value) => received.push(value));
    const first = packet(Buffer.from([0x00, 0x01]));
    const second = packet(Buffer.from([0x08, 0x02, 0x03]));

    receive(Buffer.concat([first, second]));

    assert.deepStrictEqual(received, [first, second], 'all packets in one TCP chunk must be dispatched');
}

{
    const received = [];
    const receive = Server.packetReceiver((value) => received.push(value));
    const expected = packet(Buffer.from([0x0d, 0x00, 0x00, 0x00, 0x00]));

    receive(expected.subarray(0, 3));
    assert.deepStrictEqual(received, [], 'partial packet must wait for its remaining bytes');
    receive(expected.subarray(3));

    assert.deepStrictEqual(received, [expected], 'packet split across TCP chunks must be reassembled');
}

{
    const received = [];
    const invalidSizes = [];
    const receive = Server.packetReceiver(
        (value) => received.push(value),
        (size) => invalidSizes.push(size)
    );

    receive(Buffer.from([0x01, 0x00, 0xff]));

    assert.deepStrictEqual(received, []);
    assert.deepStrictEqual(invalidSizes, [1], 'invalid frame sizes must be rejected instead of desynchronizing the stream');
}

console.log('TCP packet framing tests passed');
