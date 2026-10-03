const assert = require('assert');
require('../src/Global');
const Menu = invoke('GameServer/World/Generics/NpcBypasses/BotFriends');
const Native = invoke('GameServer/World/Generics/NpcBypasses/NativeFriends');
const Protocol = invoke('GameServer/World/Generics/NativeFriendsProtocol');
const Friends = invoke('GameServer/Bot/AI/BotFriendship');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Database = invoke('Database');
const restores = [];
function replace(object, key, value) { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; }
const packets = [];
const session = { actor: { fetchId: () => 42 }, dataSendToMe: (p) => packets.push(p) };
const rows = Array.from({ length: 9 }, (_, i) => ({ botId: 100 + i, name: `Friend${i}`, level: 55,
    classId: 16, className: 'Bishop', role: 'healer', trust: i ? 20.5 : 2, familiarity: 7.25,
    selected: i === 1, activity: 'hunting', currentRegion: 'Giran' }));
function body() {
    const p = packets.at(-1); assert.strictEqual(p[0], 0x0f);
    let end = 5; while (p.readUInt16LE(end)) end += 2;
    return p.subarray(5, end).toString('utf16le');
}
const command = (value) => Native(session, ['native-friends', ...value.split(' ')]);
(async () => {
    try {
        // Exercise real SQL pagination: native pages use 8 + one lookahead, legacy pages stay 12.
        let sqlArgs;
        replace(Database, 'execute', ([sql, params]) => {
            assert(sql.includes('WHERE s.playerId = ?')); sqlArgs = params;
            return Promise.resolve(rows);
        });
        let page = await Friends.listWindowPage(session, 'friends', 2);
        assert.deepStrictEqual(sqlArgs.slice(-2), [9, 16]); assert.strictEqual(sqlArgs[0], 42);
        assert.strictEqual(page.rows.length, 8); assert(page.hasNext);
        await Friends.listFriends(session, 2); assert.deepStrictEqual(sqlArgs.slice(-2), [12, 24]);
        const load = async (_s, _mode, n) => ({ rows: n === 0 ? rows.slice(0, 8) : rows.slice(8), hasNext: n === 0 });
        replace(Friends, 'listWindowPage', load);
        replace(Friends, 'listCandidates', async () => rows.slice(0, 8));
        replace(Friends, 'listFriends', async () => rows.slice(0, 8));
        replace(Friends, 'selectedCount', async () => 1);
        await Menu.render(session, 'add', 0, null, { open: true });
        assert(body().includes('<title>Bot Friends</title>'));
        invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'native-friends open 1' });
        await new Promise((resolve) => setImmediate(resolve));
        assert(body().includes('state\tadd\t0\t1\t1\t8\t1\t8\t'));
        assert(body().includes('\t20.5\t7.25\t1\t'));
        if (process.argv[2]) require('fs').writeFileSync(process.argv[2], Buffer.from(body(), 'utf16le'));
        for (const invalid of ['tab bad', 'page -1', 'page 99', 'const 100', 'request 999', 'form']) {
            const before = packets.length; await command(invalid); assert.strictEqual(packets.length, before);
        }
        let requests = 0;
        replace(Life, 'findByName', async (name) => ({ characterId: rows.find((r) => r.name === name).botId, name }));
        replace(Friends, 'request', async (s, state) => {
            assert.strictEqual(s, session); assert.strictEqual(state.characterId, 100); requests++;
            return { ok: false, reason: 'low_trust' };
        });
        await command('request 100'); assert.strictEqual(requests, 1); assert(body().includes('Declined:'));
        replace(Life, 'findByName', async () => ({ characterId: 999 }));
        await command('request 100'); assert.strictEqual(requests, 1, 'name must still identify the visible bot');
        await command('tab friends');
        replace(Friends, 'toggleConst', async (s, id) => { assert.strictEqual(id, 100); return { ok: false, reason: 'const_full' }; });
        await command('const 100'); assert(body().includes('already has 8 members'));
        await command('page 1'); assert.strictEqual(session.nativeFriendsVisible.length, 1);
        const last = packets.length; await command('page 2'); assert.strictEqual(packets.length, last);
        replace(Friends, 'remove', async (s, id) => {
            assert.strictEqual(s, session); assert.strictEqual(id, 108);
            Friends.listWindowPage = async (_s, _mode, n) => ({ rows: n ? [] : rows.slice(0, 8), hasNext: false });
            return { ok: true };
        });
        await command('remove 108'); assert.strictEqual(session.botFriendsView.page, 0);
        assert(body().includes('Social memory was kept'));
        replace(Friends, 'selected', async () => rows.slice(0, 2));
        let resolveInvite, invited = [];
        replace(World, 'inviteFriendByName', (s, actor, name, distribution, source) => {
            assert.strictEqual(s, session); assert.strictEqual(actor, session.actor); assert.strictEqual(source, 'friend_const');
            assert.strictEqual(distribution, undefined);
            assert.strictEqual(Party.distributionForLeader(s), 0, 'Form inherits the setting reported by the client');
            invited.push(name); return new Promise((resolve) => { resolveInvite = resolve; });
        });
        invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'native-party distribution 0' });
        const forming = command('form'); await Promise.resolve(); await Promise.resolve();
        await command('form'); assert.deepStrictEqual(invited, ['Friend0'], 'double click cannot duplicate or parallelize invites');
        resolveInvite(true); await Promise.resolve(); await Promise.resolve();
        assert.deepStrictEqual(invited, ['Friend0', 'Friend1']);
        await command('close'); const closed = packets.length;
        resolveInvite(false); await forming; assert.strictEqual(packets.length, closed);
        assert(!session.nativeFriendsBusy);
        await Menu.render(session, 'friends', 0, null, { open: true });
        // A later refresh wins even if an earlier database query finishes last.
        let finishOld;
        Friends.listWindowPage = () => new Promise((resolve) => { finishOld = resolve; });
        const stale = command('refresh');
        Friends.listWindowPage = async () => ({ rows: [rows[3]], hasNext: false });
        await command('refresh'); const fresh = packets.length;
        finishOld({ rows: [rows[0]], hasNext: false }); await stale;
        assert.strictEqual(packets.length, fresh); assert.strictEqual(session.nativeFriendsVisible[0].id, 103);
        Friends.listWindowPage = () => new Promise((resolve) => { finishOld = resolve; });
        const departed = command('refresh'); const actor = session.actor; session.actor = { fetchId: () => 999 };
        finishOld({ rows: [rows[0]], hasNext: false }); await departed;
        assert.strictEqual(packets.length, fresh); session.actor = actor;
        Friends.listWindowPage = async () => { throw new Error('test read failure'); };
        await command('refresh'); assert(body().includes('Could not load friends'));
        assert.deepStrictEqual(session.nativeFriendsVisible, []);
        await command('open 0'); assert(body().includes('<title>Bot Friends</title>'));
        const sanitized = Protocol.encode({ mode: 'friends', page: 0, threshold: 8, selectedCount: 0 }, [{ ...rows[0], name: 'Name\n\t\0X' }]);
        assert.strictEqual(sanitized.split('\n').length, 3); assert(!sanitized.includes('\0'));
    } finally { restores.reverse().forEach((restore) => restore()); }
    console.log('Native friends: pagination, HTML fallback, trust, const limit, identity checks, sequential invites, close and stale reads passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
