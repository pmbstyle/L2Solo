const assert = require('assert');
const fs = require('fs');
require('../src/Global');
// Advance a monotonic test clock between intentional UI actions. Burst behavior
// is exercised separately by test_native_item_requests.js.
let requestTime = 0;
Object.defineProperty(require('node:perf_hooks').performance, 'now', { configurable: true, value: () => requestTime });
const Native = invoke('GameServer/World/Generics/NpcBypasses/NativeItems');
const Protocol = invoke('GameServer/World/Generics/NativeItemsProtocol');
const Speak = invoke('GameServer/Network/Request/Speak');
const Send = invoke('Packet/Send');
const catalog = invoke('GameServer/World/Generics/NativeKnowledgeBase')();
const oldRate = process.env.L2NODE_PROGRESSION_RATE;
const packets = [], fixtures = [];
const session = { accountId: 'player_item_ui', actor: { fetchId: () => 42, fetchName: () => 'ItemTester' }, dataSendToMe: (p) => packets.push(p) };
function body() { const p = packets.at(-1); assert.strictEqual(p[0], 0x0f); let end = 5; while (p.readUInt16LE(end)) end += 2;
    assert(end <= 5 + 8192 * 2); return p.subarray(5, end).toString('utf16le'); }
const state = () => body().split('\n')[1].split('\t');
const rows = () => body().split('\n').slice(2).map((line) => line.split('\t'));
const command = (text) => { requestTime += 250; return Native(session, ['native-items', ...text.split(' ')]); };
const speak = (text) => { requestTime += 250; return Speak(session, new Send(0x38).writeS(text).writeD(0).fetchBuffer(false)); };
const fixture = () => fixtures.push(body());
try {
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    const rareChances = [0, 100, 1.666, 0.05, 0.01, 0.00432, 0.000001, 0.00000001];
    for (const tab of ['drops', 'spoils']) {
        const detail = { id: 1, sources: { [tab]: rareChances.map((chancePercent) => ({ id: 0, chancePercent })) } };
        assert.deepStrictEqual(Native.sourceRows(detail, tab, 0).rows.map((r) => r.chance),
            ['0.00', '100.00', '1.67', '0.05', '0.01', '0.0043', '0.0000010', '0.00000001']);
    }
    speak('.items Sword of Revolution');
    assert(body().includes('<title>Item Database</title>'), 'unmodified clients get HTML');
    assert.strictEqual(session.nativeItemsView.query, 'Sword of Revolution');
    invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'native-items open 1' });
    assert(body().startsWith(Protocol.PREFIX)); assert.strictEqual(state()[5], 'Sword of Revolution');
    assert.strictEqual(rows()[0][2], 'Sword of Revolution', 'exact name comes before dual swords and recipes'); fixture();
    const swordId = Number(rows()[0][1]), epoch = Number(state()[1]);
    command(`inspect ${swordId}`); assert.strictEqual(state()[4], 'drops'); assert.strictEqual(Number(state()[11]), swordId); fixture();
    command('tab spoils'); assert.strictEqual(state()[4], 'spoils'); fixture();
    command('list'); assert.strictEqual(state()[5], 'Sword of Revolution'); assert.strictEqual(state()[8], '0');
    command('page 1'); assert.strictEqual(state()[8], '1');
    const other = rows()[0][1]; command(`inspect ${other}`); command('list'); assert.strictEqual(state()[8], '1', 'back retains list page');
    command('filter weapons d -'); assert.strictEqual(state()[6], 'weapons'); assert.strictEqual(state()[7], 'd');
    assert(rows().every((r) => r[3] === 'd' && r[4] === 'weapons')); fixture();
    command('filter all all Recipe%3A%20Blue%20Wolf'); assert.strictEqual(state()[5], 'Recipe: Blue Wolf');
    assert(rows().length && rows().every((r) => r[2].toLowerCase().includes('recipe: blue wolf'))); fixture();
    command('filter all all NonexistentItem9xyz'); assert.strictEqual(state()[10], '0'); assert.strictEqual(state()[9], '1'); fixture();
    let count = packets.length;
    for (const invalid of ['filter bad all -', 'filter all z -', 'filter all all %zz', 'page -1', 'inspect 999999', 'tab bad']) {
        command(invalid); assert.strictEqual(packets.length, count, invalid);
    }
    command('filter all all 1'); assert.strictEqual(rows()[0][1], '1', 'exact item ID ranks first');
    for (const preset of ['x1', 'x10', 'x50']) {
        process.env.L2NODE_PROGRESSION_RATE = preset;
        for (const id of [1, 57, 1872]) {
            command(`filter all all ${id}`); assert.strictEqual(Number(rows()[0][1]), id);
            command(`inspect ${id}`);
            for (const tab of ['drops', 'spoils']) {
                command(`tab ${tab}`);
                const detail = catalog.itemDetail(id), sources = detail.sources[tab];
                assert.strictEqual(Number(state()[10]), sources.length);
                rows().forEach((r, index) => {
                    const actual = Number(r[7]), expected = sources[index].chancePercent;
                    if (expected > 0) assert(actual > 0, 'positive drop/spoil chances survive wire formatting');
                    assert(Math.abs(actual - expected) <= Math.min(0.005, expected * 0.05) + 1e-12,
                        `displayed chance ${r[7]} stays close to catalog chance ${expected}`);
                });
                fixture();
                command('page 999999'); assert.strictEqual(Number(state()[8]), Number(state()[9]) - 1); fixture();
            }
        }
    }
    // Dataset list pagination passes the actual server wire serializer, not a mock renderer.
    command('filter all all -'); const pages = Number(state()[9]);
    for (let page = 0; page < pages; page++) { command(`page ${page}`); fixture(); }
    command('close'); count = packets.length; command('refresh'); assert.strictEqual(packets.length, count);
    speak('.items'); assert(Number(state()[1]) > epoch && state()[3] === '1');
    command('open 0'); assert(body().includes('<title>Item Database</title>'));
    command('search <script>'); assert(!body().includes('<script>'), 'HTML fallback never inserts unescaped query');
    if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from(fixtures.join('\0'), 'utf16le'));
    assert.throws(() => Protocol.encode({ rows: Array(9).fill({}) }), /bounds/);
    console.log(`Native item database: real .items and bypass, legacy fallback, filters, exact search, preserved pages, rates, ${fixtures.length} wire fixtures passed`);
} finally {
    if (oldRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE; else process.env.L2NODE_PROGRESSION_RATE = oldRate;
}
