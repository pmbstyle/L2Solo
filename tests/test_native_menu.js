const assert = require('assert');
const fs = require('fs');
require('../src/Global');
const Menu = invoke('GameServer/World/Generics/NpcBypasses/NativeMenu');
const Speak = invoke('GameServer/Network/Request/Speak');
const Send = invoke('Packet/Send');
const packets = [], calls = [], fixtures = [];
const session = { accountId: 'menu_test', actor: { fetchId: () => 42, fetchName: () => 'MenuTester' }, dataSendToMe: (p) => packets.push(p) };
const body = () => {
    const p = packets.at(-1); assert.strictEqual(p[0], 0x0f);
    let end = 5; while (p.readUInt16LE(end)) end += 2;
    return p.subarray(5, end).toString('utf16le');
};
const speak = (text) => Speak(session, new Send(0x38).writeS(text).writeD(0).fetchBuffer(false));
const bypass = (text) => invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: `native-menu ${text}` });
bypass('run 1 9');assert(!packets.length, 'no execution before opening');
speak(' .MeNu ');assert(body().includes('<title>Server Menu</title>'));
for (const entry of Menu.COMMANDS) assert(body().includes(entry.command) && body().includes(entry.label));
assert(!body().includes('.admin') && !body().includes('.trade<') && !body().includes('.bpath'));
assert.strictEqual(Menu.COMMANDS.length, 11);
bypass('open 1');assert(body().startsWith(Menu.PREFIX));
assert.strictEqual(body().split('\n').length, 13);
assert(body().includes('\t.bp\t') && body().includes('\t.bf\t'), 'legacy native shortcuts remain available');
const epoch = session.nativeMenuEpoch;
bypass(`close ${epoch}`);const before = packets.length;bypass('open 1');assert.strictEqual(packets.length, before);
speak('.menu');assert(session.nativeMenuEpoch > epoch && body().startsWith(Menu.PREFIX));
// The menu may dispatch only a fixed no-argument command through the same
// chat consumer. Do not sell inventory or start stores in this routing test.
const consume = Speak.consume;
try {
    Speak.consume = (s, data) => { assert.strictEqual(s, session);calls.push(data); };
    for (const entry of Menu.COMMANDS) {
        speak('.menu'); const generation = session.nativeMenuEpoch;
        for (const bad of [`run ${generation} 0`, `run ${generation} 12`, `run ${generation} .admin`,
            `run ${generation} ${entry.id} extra`, `run ${generation - 1} ${entry.id}`, `run 0${generation} ${entry.id}`]) {
            const count = calls.length; bypass(bad); assert.strictEqual(calls.length, count);
        }
        const count = calls.length;bypass(`run ${generation} ${entry.id}`);
        assert.strictEqual(calls.length, count + 1);
        assert.deepStrictEqual(calls.at(-1), { kind: 0, text: entry.command });
        assert.strictEqual(session.nativeMenuOpen, false);
        bypass(`run ${generation} ${entry.id}`);assert.strictEqual(calls.length, count + 1, 'duplicate click consumed once');
    }
} finally { Speak.consume = consume; }
speak('.menu');bypass('open 0');assert(body().includes('<title>Server Menu</title>'));
assert(body().includes(`native-menu run ${session.nativeMenuEpoch} 1`));
// Prove actual shared-consumer dispatch for two windows, without touching live state.
const Items = invoke('GameServer/World/Generics/NpcBypasses/NativeItems');
const Party = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const itemsOpen = Items.open, partyRender = Party.render;
let opened = [];
try {
    Items.open = (s) => { assert.strictEqual(s, session);opened.push('items'); };
    Party.render = (s, page, options) => { assert.strictEqual(s, session);assert(options.open);opened.push('party'); };
    for (const id of [1, 5]) { speak('.menu');bypass(`run ${session.nativeMenuEpoch} ${id}`); }
    assert.deepStrictEqual(opened, ['party', 'items']);
} finally { Items.open = itemsOpen;Party.render = partyRender; }
const Hub = invoke('GameServer/World/Generics/NpcBypasses/NativePartyHub');
Hub(session, ['native-party-hub', 'open', '2', 'party']);
speak('.menu');bypass('open 1');
assert.strictEqual(body().split('\n').length, 11);
assert(!body().includes('\t.bp\t') && !body().includes('\t.bf\t'), 'negotiated hub uses a single Party entry');
fixtures.push(body());
bypass(`run ${session.nativeMenuEpoch} 2`);
assert(session.nativeMenuOpen, 'hidden shortcuts cannot consume the menu opening');
speak('.menu');fixtures.push(body());
if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from(fixtures.join('\0'), 'utf16le'));
console.log('Server menu: stock, legacy native and Party Hub menus, canonical routes and stale/hidden/duplicate actions passed');
