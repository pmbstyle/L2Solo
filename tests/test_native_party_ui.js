const assert = require('assert');
require('../src/Global');
const Protocol = invoke('GameServer/World/Generics/NativePartyProtocol');
const NativeParty = invoke('GameServer/World/Generics/NpcBypasses/NativeParty');
const CompanionControl = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const BotManager = invoke('GameServer/Bot/BotManager');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');
const Speak = invoke('GameServer/Network/Request/Speak');
const SendPacket = invoke('Packet/Send');
const ActorGenerics = invoke(path.actor);

function actor(id, name) {
    return {
        fetchId: () => id, fetchName: () => name, fetchLevel: () => 40,
        isDead: () => false,
        fetchLocX: () => 10, fetchLocY: () => 20, fetchLocZ: () => 30,
        state: { fetchDead: () => false },
        clearDestId() {}, automation: { abortAll() {} }
    };
}
const packets = [];
const leader = { actor: actor(1, 'Leader'), dataSendToMe: (p) => packets.push(p) };
let members = Array.from({ length: 8 }, (_, i) => ({ actor: actor(i + 10, `Companion${i}`),
    accountId: `bot_companion_${i}`, dataSendToMeAndOthers() {} }));
let settings = { combatMode: 'assist', movementMode: 'follow', pullMode: 'auto' };
const restore = [];
function replace(object, key, value) {
    const old = object[key]; restore.push(() => { object[key] = old; }); object[key] = value;
}
function body(packet = packets.at(-1)) {
    assert.strictEqual(packet[0], 0x0f);
    assert.strictEqual(packet.readInt32LE(1), 1);
    let end = 5;
    while (packet.readUInt16LE(end) !== 0) end += 2;
    assert.strictEqual(packet.readInt32LE(end + 2), 0, 'C4 trailing field');
    return packet.subarray(5, end).toString('utf16le');
}
function command(value) { NativeParty(leader, ['native-party', ...value.split(' ')]); }
try {
    replace(Party, 'membersForLeader', (session) => session === leader ? members : []);
    replace(Party, 'getSettings', () => settings);
    replace(Party, 'updateSettings', (_session, patch) => Object.assign(settings, patch));
    replace(BotManager, 'getBotStatus', () => ({ intent: 'idle' }));
    replace(BotManager, 'botSay', () => {});
    replace(BotRoles, 'inferRole', () => 'dps');
    replace(BotRoles, 'presentation', () => ({ classId: 2, role: 'dps', className: 'Gladiator' }));

    CompanionControl.render(leader);
    assert(body().includes('<title>Party Control</title>'), 'unmodified client receives HTML');
    const legacy = body();
    command('action combat passive');
    assert.strictEqual(settings.combatMode, 'assist', 'orders require negotiation');
    NpcTalkResponse(leader, { link: 'native-party open 1' });
    assert(body().startsWith(Protocol.PREFIX), 'actual bypass route negotiates native UI');
    assert(body().includes('state\tassist\tfollow\tauto\t8\t1'));
    assert.strictEqual(body().split('\n').length, 10, 'all eight companions fit one packet');
    assert(body().length < 8192);

    command('action combat passive');
    assert.strictEqual(settings.combatMode, 'passive');
    assert(body().includes('state\tpassive\tfollow\tauto\t8\t0'));
    command('member 10 stay');
    assert.strictEqual(members[0].botStay, true);
    assert.deepStrictEqual(members[0].stayLocation, { locX: 10, locY: 20, locZ: 30 });
    command('member 10 follow');
    assert.strictEqual(members[0].botStay, false);
    for (const combatMode of ['assist', 'protect', 'passive']) {
        command(`action combat ${combatMode}`);
        assert.strictEqual(settings.combatMode, combatMode);
    }
    command('action movement hold');
    assert(members.every((m) => m.botStay === true), 'group Hold applies to every companion');
    command('action movement follow');
    assert(members.every((m) => m.botStay === false), 'group Follow clears individual anchors');
    for (const pullMode of ['auto', 'leader', 'off']) {
        command(`action pull ${pullMode}`);
        assert.strictEqual(settings.pullMode, pullMode);
        assert(members.every((m) => m.autoTaunt === (pullMode !== 'off')));
    }
    command('member 10 pull-on');
    assert.strictEqual(settings.pullMode, 'bot');
    assert.strictEqual(settings.pullerId, 10);
    assert.strictEqual(members[0].partyPuller, true);
    command('member 11 pull-on');
    assert.strictEqual(settings.pullerId, 11, 'a new Pull order replaces the assigned puller');
    assert.strictEqual(members[0].partyPuller, false);
    command('member 11 pull-off');
    assert.strictEqual(settings.pullMode, 'off', 'Stop Pull disables autonomous pulling');
    assert(members.every((m) => m.autoTaunt === false));
    settings.pullMode = 'auto';
    const teleports = [];
    replace(ActorGenerics, 'updatePosition', (session, _actor, coords) => teleports.push({ session, coords }));
    const originalTimeout = global.setTimeout;
    const teleportCallbacks = [];
    global.setTimeout = (callback, ms) => { assert.strictEqual(ms, 1000); teleportCallbacks.push(callback); };
    try {
        command('member 10 summon');
        teleportCallbacks.shift()();
        assert.deepStrictEqual(teleports[0], { session: members[0], coords: { locX: 70, locY: 80, locZ: 30 } },
            'Call invokes the real teleport handler for the selected companion');
        command('action regroup');
        teleportCallbacks.splice(0).forEach((callback) => callback());
        assert.strictEqual(teleports.length, 9, 'Regroup teleports all eight current companions');
    } finally { global.setTimeout = originalTimeout; }
    command('member 999 stay');
    assert(members.every((m) => !m.botStay), 'outsider cannot be controlled');
    const removed = members.shift();
    command('member 10 stay');
    assert.strictEqual(removed.botStay, false, 'stale row cannot control a removed member');
    for (const invalid of ['action combat bogus', 'action loot bogus', 'action constructor foo', 'member -1 stay', 'member 11 dismiss']) {
        const before = packets.length; command(invalid); assert.strictEqual(packets.length, before);
    }

    command('close');
    const before = packets.length;
    CompanionControl.render(leader);
    command('refresh'); command('action combat assist');
    assert.strictEqual(packets.length, before, 'closed panels do not receive background updates');
    assert.strictEqual(settings.combatMode, 'passive');
    Speak(leader, new SendPacket(0x38).writeS('.b').writeD(0).fetchBuffer(false));
    assert.strictEqual(leader.nativePartyUiOpen, true, '.b explicitly reopens the native panel');
    assert(body().includes('state\tpassive\tfollow\tauto\t7\t1'));
    members.unshift(removed); settings.combatMode = 'assist';
    command('open 0');
    assert.strictEqual(body(), legacy, 'fallback preserves existing HTML output');
    command('open 2');
    assert(body().startsWith(Protocol.PREFIX_V2), 'new clients negotiate the extended snapshot');
    assert(body().split('\n').slice(2).every((line) => line.split('\t').length === 10), 'v2 member format stays unchanged');
    assert(body().includes('state\tassist\tfollow\tauto\t8\t1\t1'), 'pickup defaults to enabled');
    command('action loot off');
    assert.strictEqual(settings.lootPickupEnabled, false);
    assert(body().includes('state\tassist\tfollow\tauto\t8\t0\t0'), 'native selection follows the server');
    command('refresh');
    assert.strictEqual(settings.lootPickupEnabled, false, 'Refresh preserves the toggle');
    command('close');
    command('action loot on');
    assert.strictEqual(settings.lootPickupEnabled, false, 'closed panels cannot issue orders');
    command('open 2');
    assert(body().includes('state\tassist\tfollow\tauto\t8\t1\t0'), 'reopen preserves the toggle');
    NpcTalkResponse(leader, { link: 'native-party open 3' });
    assert.strictEqual(leader.nativePartyUiVersion, 3);
    assert(body().startsWith(Protocol.PREFIX_V3), 'current quick menu route negotiates class icons and pickup controls');
    assert(body().includes('state\tassist\tfollow\tauto\t8\t1\t0'));
    for (const line of body().split('\n').slice(2)) {
        const fields = line.split('\t');
        assert.strictEqual(fields.length, 11);
        assert.strictEqual(fields[10], '2', 'the presentation class ID reaches every member row');
    }
    command('action loot on');
    assert.strictEqual(settings.lootPickupEnabled, true);
    assert(body().includes('state\tassist\tfollow\tauto\t8\t0\t1'));
    command('action loot off');
    command('refresh');
    assert.strictEqual(settings.lootPickupEnabled, false);
    command('close');
    command('open 3');
    assert(body().includes('state\tassist\tfollow\tauto\t8\t1\t0'), 'v3 reopen preserves Off');
    command('open 0');
    assert(body().includes('companion-control loot on'), 'stock HTML clients can enable pickup');
    CompanionControl(leader, ['companion-control', 'loot', 'on']);
    assert.strictEqual(settings.lootPickupEnabled, true);
    members = [];
    command('open 3');
    assert.strictEqual(body(), Protocol.PREFIX_V3 + 'state\tassist\tfollow\tauto\t0\t1\t1');
    command('open 1');
    assert.strictEqual(body(), Protocol.PREFIX + 'state\tassist\tfollow\tauto\t0\t1');

    const hostile = { id: 20, name: 'Алиса\t\n\0' + 'x'.repeat(40), level: 40,
        classId: 136, className: 'c'.repeat(60), role: 'dps', stance: 'hold', order: '\nmember\t99', note: 'n'.repeat(200), canPull: true };
    const bounded = Protocol.encode(settings, Array.from({ length: 9 }, (_, i) => ({ ...hostile, id: i + 20 })));
    const lines = bounded.split('\n');
    assert.strictEqual(lines.length, 10);
    for (const line of lines.slice(2)) {
        const fields = line.split('\t');
        assert.strictEqual(fields.length, 10);
        assert.strictEqual(fields[2].length, 32);
        assert.strictEqual(fields[4].length, 40);
        assert.strictEqual(fields[8].length, 64);
        assert(!line.includes('\0'));
    }
    for (const classId of [0, 2, 136, undefined, null, -1, 137, 2.5, '2']) {
        const payload = Protocol.encode(settings, [{ ...hostile, classId }], { version: 3 });
        const expected = [0, 2, 136].includes(classId) ? classId : -1;
        assert.strictEqual(payload.split('\n')[2].split('\t')[10], String(expected), 'unknown classes do not become fighter icons');
    }
    command('open 4');
    assert.strictEqual(leader.nativePartyUiVersion, 0, 'unsupported versions fall back to HTML');
    assert(body().includes('<title>Party Control</title>'));
    if (process.argv[2]) require('fs').writeFileSync(process.argv[2], Buffer.from(
        Protocol.encode({ ...settings, lootPickupEnabled: false }, Array.from({ length: 8 }, (_, i) => ({ ...hostile, id: i + 20 })), { version: 3 }), 'utf16le'));
} finally { restore.reverse().forEach((fn) => fn()); }
console.log('Native party UI: wire format, full/empty party, negotiation, fallback, reopen and current membership checks passed');
