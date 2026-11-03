'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../src/Global');
const Session = invoke('GameServer/Session');

// The packet trace and the e2e client name a server packet after the Network/Response file that sends
// its opcode. The table was hand-written and had drifted (0x28 read NpcSay for TeleportToLocation,
// 0x3a VehicleInfo for JoinParty); this keeps it the files' own.
const dir = path.join(__dirname, '../src/GameServer/Network/Response');
const sent = new Map(), extended = new Map();
for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8'), name = file.replace(/\.js$/, '');
    for (const match of text.matchAll(/new SendPacket\((0x[0-9a-fA-F]+)\)/g)) {
        const opcode = parseInt(match[1], 16);
        const target = opcode === 0xfe ? extended : sent;
        const key = opcode === 0xfe ? parseInt(/writeH\((0x[0-9a-fA-F]+)\)/.exec(text.slice(match.index, match.index + 200))?.[1], 16) : opcode;
        if (!Number.isFinite(key)) continue;
        target.set(key, [...(target.get(key) || []), name]);
    }
}
for (const [opcode, files] of sent) {
    assert.ok(files.includes(Session.SERVER_PACKET_NAMES[opcode]),
        `0x${opcode.toString(16)} is sent by ${files.join(', ')} but named ${Session.SERVER_PACKET_NAMES[opcode]}`);
}
for (const opcode of Object.keys(Session.SERVER_PACKET_NAMES).map(Number)) {
    assert.ok(sent.has(opcode), `0x${opcode.toString(16)} is named ${Session.SERVER_PACKET_NAMES[opcode]} but no Response file sends it`);
}
for (const [sub, files] of extended) assert.ok(files.includes(Session.EXTENDED_SERVER_PACKET_NAMES[sub]), `0xfe:0x${sub.toString(16)}`);
assert.equal(Session.serverPacketName(0x28), 'TeleportToLocation');
assert.equal(Session.serverPacketName(0xfe, 0x2e), 'ExStorageMaxCount');
assert.equal(Session.serverPacketName(0xfe, 0x99), 'Ex0x99');
assert.equal(Session.serverPacketName(0x99), 'Unknown');
console.log('test_server_packet_names passed');
