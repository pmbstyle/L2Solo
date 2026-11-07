const assert = require('assert');
const { useRate } = require('./helpers/progressionRate');
const fs = require('fs');
require('../src/Global');
const Native = invoke('GameServer/World/Generics/NpcBypasses/NativeDrop');
const Protocol = invoke('GameServer/World/Generics/NativeDropProtocol');
const World = invoke('GameServer/World/World');
const Index = invoke('GameServer/World/NpcObjectIndex');
const { createKnowledgeBaseService } = require('../src/WorldObserver/KnowledgeBaseService');
const knowledge = createKnowledgeBaseService({ dataDir: require('path').join(__dirname, '../data/KnowledgeBase'),
    progressionRates: invoke('GameServer/ProgressionRates') });
const oldFind = Index.find, oldRate = process.env.L2NODE_PROGRESSION_RATE;
const packets = [];
let selected = 40001, template = 1, attackable = true, exists = true;
const npc = { fetchId: () => 40001, fetchSelfId: () => template,
    fetchDispSelfId: () => 1000674, fetchAttackable: () => attackable };
const session = { actor: { fetchDestId: () => selected }, dataSendToMe: (p) => packets.push(p) };
const body = () => { const p = packets.at(-1); assert.strictEqual(p[0], 0x0f);
    let end = 5; while (p.readUInt16LE(end)) end += 2; return p.subarray(5, end).toString('utf16le'); };
const request = (id = selected, token = 1) => { session.nativeDropAt = 0;
    Native(session, ['native-drop', '1', String(token), String(id)]); };
try {
    Index.find = (world, id) => { assert.strictEqual(world, World); return exists && id === 40001 ? npc : null; };
    useRate('x1');
    invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'native-drop 1 7 40001' });
    assert(body().startsWith(Protocol.PREFIX));
    let fields = body().split('\n')[1].split('\t');
    assert.deepStrictEqual(fields.slice(0, 6), ['state', '7', '40001', '1', 'ok', 'Gremlin']);
    assert.strictEqual(packets.at(-1).readInt32LE(1), 40001);
    assert(body().includes('6.99759273'), 'must use the observer probability, not item-selection weight');
    if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from(body(), 'utf16le'));
    let count = packets.length;
    session.nativeDropAt = Date.now();
    Native(session, ['native-drop', '1', '8', '40001']); assert.strictEqual(packets.length, count, 'throttled');
    for (const invalid of [['0', '1', '40001'], ['1', '-1', '40001'], ['1', '1', '2147483648'], ['1', '1', '40001', 'extra']]) {
        session.nativeDropAt = 0; Native(session, ['native-drop', ...invalid]); assert.strictEqual(packets.length, count);
    }
    request(123); assert.strictEqual(packets.length, count, 'cannot query an unselected object');
    selected = 40002; request(40001); assert.strictEqual(packets.length, count, 'stale target rejected');
    selected = 40001;
    for (const preset of ['x1', 'x10', 'x50']) {
        useRate(preset);
        for (const id of [1, 674, 10487]) {
            template = id; request();
            const expected = Native.rewardRows(knowledge.npcDetail(id));
            const actual = body().split('\n').slice(2).map((line) => line.split('\t'));
            assert.deepStrictEqual(actual, expected.map((r) => [r.kind, String(r.group), String(r.itemId), r.name, r.amount, r.chance]));
        }
    }
    // Full shipped dataset fits the packet and renderer, with both reward types,
    // but Antharas: its 90 C4 (Lisvus) rows pass the 64-row bound and the target
    // shows the tooltip as unavailable (debt: the tooltip has no pages).
    const mobs = require('../data/KnowledgeBase/mobs.json'); let maxRows = 0;
    const fixtures = [], oversize = [];
    for (const mob of mobs) {
        const detail = knowledge.npcDetail(mob.id), rows = Native.rewardRows(detail);
        if (rows.length > 64) {
            oversize.push(mob.id);
            assert.throws(() => Protocol.encode({ rows }), /bounds/);
            continue;
        }
        const encoded = Protocol.encode({ request: 1, objectId: 40001, npcId: mob.id, name: detail.name,
            status: rows.length ? 'ok' : 'empty', rows });
        maxRows = Math.max(maxRows, rows.length); assert(encoded.length <= 8192);
        assert(rows.every((r) => /^\d+(?:-\d+)?$/.test(r.amount) && r.amount.length <= 25 && Number(r.chance) <= 100));
        fixtures.push(encoded);
    }
    assert.deepStrictEqual(oversize, [12211]);
    template = 12211; request(); assert(body().includes('\tunavailable\t'), 'an oversize list is sent as unavailable');
    assert(maxRows <= 35); // 39 display lines including empty-section labels fit 800x600.
    if (process.argv[3]) fs.writeFileSync(process.argv[3], Buffer.from(fixtures.join('\0'), 'utf16le'));
    attackable = false; request(); assert(body().includes('\tunavailable\t'));
    attackable = true; exists = false; request(); assert(body().includes('\tunavailable\t'));
    exists = true; template = 999999; request(); assert(body().includes('\tunavailable\t'));
    assert.throws(() => Protocol.encode({ rows: Array(65).fill({}) }), /bounds/);
    console.log(`Native drop UI: real bypass/packet, target validation, display-template isolation, rates, ${mobs.length} NPCs, max ${maxRows} rewards passed`);
} finally {
    Index.find = oldFind;
    useRate(oldRate);
}
