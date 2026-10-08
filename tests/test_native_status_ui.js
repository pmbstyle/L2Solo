const assert = require('assert');
require('../src/Global');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = true;
const Manager = invoke('GameServer/Bot/BotManager');
const Menu = invoke('GameServer/World/Generics/NpcBypasses/BotStatus');
const Native = invoke('GameServer/World/Generics/NpcBypasses/NativeStatus');
const Protocol = invoke('GameServer/World/Generics/NativeStatusProtocol');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const restores = [];
function replace(object, key, value) { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; }
const packets = []; let inspected = 0;
const session = { actor: { fetchId: () => 42, fetchDestId: () => 100 }, dataSendToMe: (p) => packets.push(p) };
const targets = Array.from({ length: 17 }, (_, i) => ({ actor: { fetchName: () => `Bot${String(i).padStart(2, '0')}`, fetchId: () => 100 + i } }));
const sample = (target) => ({ available: true, name: target.actor.fetchName(), level: 55, classId: 16, mode: 'hunting', intent: 'find_target',
    role: 'healer', vitals: { hpPct: .73, mpPct: .42 }, home: { region: 'Giran' }, party: null, target: null, spot: null,
    movement: { moving: false }, nearby: {}, blockers: [], buffs: {}, trade: {}, persona: null,
    decisions: { combat: { action: 'heal', reason: 'explanation '.repeat(25) + 'ENDOFDETAIL' } } });
function body() { const p = packets.at(-1); assert.strictEqual(p[0], 0x0f); let end = 5; while (p.readUInt16LE(end)) end += 2; return p.subarray(5, end).toString('utf16le'); }
const state = () => body().split('\n')[1].split('\t');
const command = (s) => Native(session, ['native-status', ...s.split(' ')]);
(async () => {
    try {
        replace(Manager, 'sessions', targets);
        replace(Manager, 'findSessionById', (id) => Manager.sessions.find((s) => s.actor.fetchId() === id));
        replace(Manager, 'getBotStatus', (target) => { inspected++; return sample(target); });
        replace(Availability, 'evaluate', () => ({ available: true, memory: { trust: 12.5, familiarity: 4 }, relationship: 'friendly' }));
        // Execute the real legacy renderer, then the real native route using its remembered target.
        await Menu(session, ['bot-status']); assert(body().includes('<title>Bot Status</title>')); assert.strictEqual(session.botStatusName, 'Bot00');
        invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'native-status open 1' });
        assert(body().startsWith(Protocol.PREFIX)); assert.strictEqual(state()[7], 'Bot00');
        assert.deepStrictEqual(state().slice(11, 14), ['active', '73', '42']);
        assert(body().includes('trust 12.5'));
        if (process.argv[2]) require('fs').writeFileSync(process.argv[2], Buffer.from(body(), 'utf16le'));
        await command('tab details');
        let details = body(); const pages = Number(state()[3]);
        for (let i = 1; i < pages; i++) { await command(`page ${i}`); details += body(); }
        assert(details.includes('ENDOFDETAIL') && details.includes('Combat AI (cont.)'), 'long decision explanations survive paging');
        inspected = 0; await command('list'); assert.strictEqual(inspected, 8); assert.strictEqual(state()[4], '17');
        assert.strictEqual(state()[7], 'Bot00', 'list must retain the inspected character');
        await command('tab details'); assert.strictEqual(state()[7], 'Bot00'); assert.strictEqual(state()[1], 'details');
        await command('list'); await command('tab overview');
        assert.deepStrictEqual(state().slice(11, 14), ['active', '73', '42']);
        await command('list');
        await command('page 999999'); assert.strictEqual(state()[2], '2'); assert.strictEqual(state()[6], '1');
        const before = packets.length; await command('inspect Bot00'); assert.strictEqual(packets.length, before);
        await command('inspect Bot16'); assert.strictEqual(state()[7], 'Bot16');
        const listVitals = state().slice(7, 14);
        await Menu(session, ['bot-status', 'Bot16']);
        assert.deepStrictEqual(state().slice(7, 14), listVitals, 'the same active bot must have identical vitals via list and .bs name');
        await Menu(session, ['bot-status', 'bOt16']);
        assert.deepStrictEqual(state().slice(7, 14), listVitals, 'the real name lookup is case insensitive');
        for (const invalid of ['tab bad', 'page -1']) { const n = packets.length; await command(invalid); assert.strictEqual(packets.length, n); }
        let savedVitals = { hp: 910, maxHp: 1000, mp: 230, maxMp: 500 };
        replace(Life, 'findByName', async (name) => ({ characterId: 999, name, level: 60, classId: 30, vitals: savedVitals,
            activity: 'traveling', currentRegion: 'Dion', stats: { role: 'healer', partyHistory: {}, travel: { reason: 'shopping', townName: 'Giran' } } }));
        await Menu(session, ['bot-status', 'BackgroundBot']);
        assert.deepStrictEqual(state().slice(11, 14), ['background', '91', '46']);
        savedVitals = { hp: 0, maxHp: 1000, mp: null, maxMp: 500 }; await command('refresh');
        assert.deepStrictEqual(state().slice(12, 14), ['0', '101'], 'zero HP is real, missing MP is unavailable');
        savedVitals = { hp: 15, maxHp: 0, mp: 3, maxMp: NaN }; await command('refresh');
        assert.deepStrictEqual(state().slice(12, 14), ['101', '101'], 'invalid capacities must not fabricate percentages');
        savedVitals = { hp: 910, maxHp: 1000, mp: 230, maxMp: 500 };
        await command('tab details'); assert(body().includes('shopping -> Giran'));
        assert(body().includes('Latest background simulation state'));
        let finish;
        Life.findByName = () => new Promise((resolve) => { finish = resolve; });
        const old = command('refresh'); const resolveOld = finish;
        await Menu(session, ['bot-status', 'Bot00']); const current = packets.length;
        resolveOld({ characterId: 999, name: 'BackgroundBot', level: 60 }); await old;
        assert.strictEqual(packets.length, current); assert.strictEqual(state()[7], 'Bot00');
        const closing = Menu(session, ['bot-status', 'BackgroundBot']); await command('close'); const closed = packets.length;
        finish(null); await closing; assert.strictEqual(packets.length, closed);
        const actor = session.actor;
        const changed = Menu(session, ['bot-status', 'BackgroundBot']); session.actor = { ...actor };
        finish(null); await changed; assert.strictEqual(packets.length, closed); session.actor = actor;
        Life.findByName = async () => null;
        const previousView = { ...session.nativeStatusView };
        await Menu(session, ['bot-status', 'MissingBot']);
        assert.strictEqual(packets.at(-1)[0], 0x64);
        assert(packets.at(-1).includes(Buffer.from('not found.', 'utf16le')));
        assert.deepStrictEqual(session.nativeStatusView, previousView, 'an invented name must not replace the inspected character');
        assert.strictEqual(session.nativeStatusOpen, false, 'an invented name must not open a closed window');
        await Menu(session, ['bot-status', 'Bot00']);
        const selectedView = { ...session.nativeStatusView };
        await Menu(session, ['bot-status', 'MissingBot']);
        assert.strictEqual(packets.at(-1)[0], 0x64);
        assert.deepStrictEqual(session.nativeStatusView, selectedView);
        assert.strictEqual(session.nativeStatusOpen, true, 'not found leaves an existing valid card open');
        await command('open 0'); assert(body().includes('<title>Bot Status</title>'));
        await Menu(session, ['bot-status', 'MissingBot']);
        assert.strictEqual(packets.at(-1)[0], 0x64, 'legacy clients also get an explicit not-found message, not an unrelated bot list');
    } finally { restores.reverse().forEach((fn) => fn()); }
    console.log('Native status: actual HTML renderer/negotiation, selected target, bounded list, hot/cold details, long text, stale reads and close passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
