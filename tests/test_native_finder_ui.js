const assert = require('assert');
require('../src/Global');
const Menu = invoke('GameServer/World/Generics/NpcBypasses/BotParty');
const Native = invoke('GameServer/World/Generics/NpcBypasses/NativeFinder');
const Protocol = invoke('GameServer/World/Generics/NativeFinderProtocol');
const Availability = invoke('GameServer/Bot/AI/BotAvailability');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const World = invoke('GameServer/World/World');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const restores = [];
function replace(object, key, value) { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; }
const packets = [];
const session = { actor: { fetchId: () => 1, fetchLevel: () => 55 }, dataSendToMe: (p) => packets.push(p) };
let evaluations = 0;
const entries = Array.from({ length: 23 }, (_, i) => ({
    name: `Candidate${String(i).padStart(2, '0')}`, level: 50 + (i % 10), phase: i % 2 ? 'hot' : 'cold',
    subject: { classId: i % 2 ? 16 : 55, role: i % 2 ? 'healer' : 'spoiler' },
    session: { available: i !== 3 }, state: { available: i !== 2 }
}));
function body() {
    const p = packets.at(-1); assert.strictEqual(p[0], 0x0f);
    let end = 5; while (p.readUInt16LE(end)) end += 2;
    return p.subarray(5, end).toString('utf16le');
}
const command = (value) => Native(session, ['native-finder', ...value.split(' ')]);
(async () => {
    try {
        replace(Availability, 'catalogForPlayer', () => entries);
        replace(Roles, 'presentation', (subject) => ({ ...subject, className: subject.classId === 16 ? 'Bishop' : 'Bounty Hunter' }));
        const evaluate = (_session, subject, options) => {
            assert.deepStrictEqual(options, { loadMemory: false }); evaluations++;
            return { available: subject.available, reasonText: subject.available ? 'available' : 'busy' };
        };
        replace(Availability, 'evaluate', evaluate); replace(Availability, 'evaluateState', evaluate);
        Menu.open(session);
        assert(body().includes('<title>Bot Party</title>'));
        assert.strictEqual(evaluations, 0);
        command('open 1');
        assert(body().startsWith(Protocol.PREFIX));
        assert(body().includes('state\t\t50-59\tall\t0\t3\t23\t1\t8\t'));
        assert.strictEqual(evaluations, 8, 'only visible candidates evaluate availability');
        assert.strictEqual(body().split('\n').length, 10);
        if (process.argv[2]) require('fs').writeFileSync(process.argv[2], Buffer.from(body(), 'utf16le'));
        command('filter - all healer');
        assert(body().includes('state\t\tall\thealer\t0\t2\t11\t0\t8\t'));
        assert(body().split('\n').slice(2).every((row) => row.includes('\t16\tBishop\thealer\t')));
        command('page 999999');
        assert(body().includes('state\t\tall\thealer\t1\t2\t11\t0\t3\t'));
        command('filter Candidate03 50-59 healer');
        assert(body().includes('state\tCandidate03\t50-59\thealer\t0\t1\t1\t0\t1\t'));
        assert(body().includes('\thealer\t0\tbusy\tactive'));
        command('filter Candidate03 1-19 healer');
        assert(body().includes('\t0\t1\t0\t0\t0\t'));
        command('filter - all spoiler');
        assert(body().includes('\tall\tspoiler\t0\t2\t12\t0\t8\t'));
        for (const invalid of ['filter - bogus all', 'filter - all constructor', 'page -1', 'invite Outsider']) {
            const before = packets.length; await command(invalid); assert.strictEqual(packets.length, before);
        }
        let resolveInvite; let inviteCount = 0;
        replace(World, 'inviteBotByName', (target, actor, name, distribution, source) => {
            assert.strictEqual(target, session); assert.strictEqual(actor, session.actor);
            assert.strictEqual(name, session.nativeFinderVisible[0]); assert.strictEqual(source, 'botparty');
            assert.strictEqual(distribution, undefined);
            assert.strictEqual(Party.distributionForLeader(target), 0, 'Finder Invite inherits the client-reported setting');
            inviteCount++; return new Promise((resolve) => { resolveInvite = resolve; });
        });
        invoke('GameServer/World/Generics/NpcTalkResponse')(session, { link: 'native-party distribution 0' });
        const beforeInvite = packets.length;
        const promise = command(`invite ${session.nativeFinderVisible[0]}`);
        await Promise.resolve();
        await command(`invite ${session.nativeFinderVisible[0]}`);
        assert.strictEqual(inviteCount, 1); assert.strictEqual(packets.length, beforeInvite);
        resolveInvite(true); await promise;
        assert(body().includes('Invitation processed.'));
        const pending = command(`invite ${session.nativeFinderVisible[0]}`); await Promise.resolve();
        command('close'); const closed = packets.length;
        resolveInvite(false); await pending;
        Menu.render(session); command('refresh');
        assert.strictEqual(packets.length, closed, 'late invite completion cannot reopen closed UI');
        Menu.open(session); assert.strictEqual(session.nativeFinderOpen, true);
        command('open 0'); assert(body().includes('<title>Bot Party</title>'));
        assert.strictEqual(session.nativeFinderVersion, 0);
    } finally { restores.reverse().forEach((fn) => fn()); }
    console.log('Native finder: HTML compatibility, combined filters, paging, bounded availability work, async invites and close lifecycle passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
