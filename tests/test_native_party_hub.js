const assert = require('node:assert/strict');
const fs = require('node:fs');
require('../src/Global');
const Hub = invoke('GameServer/World/Generics/NpcBypasses/NativePartyHub');
const Protocol = invoke('GameServer/World/Generics/NativePartyHubProtocol');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Commands = invoke('GameServer/Bot/AI/ClanCommandParty');
const Control = invoke('GameServer/World/Generics/NpcBypasses/CompanionControl');
const Finder = invoke('GameServer/World/Generics/NpcBypasses/BotParty');
const Friends = invoke('GameServer/Bot/AI/BotFriendship');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Manager = invoke('GameServer/Bot/BotManager');
const Clans = invoke('GameServer/Clan/ClanService');
const World = invoke('GameServer/World/World');
const Reset = invoke('GameServer/World/Generics/NativeUiSession');
const Presets = invoke('GameServer/Bot/AI/PlayerPartyPreset');
const DB = invoke('Database');
const Speak = invoke('GameServer/Network/Request/Speak');
const Send = invoke('Packet/Send');
const restores = [], packets = [], fixtures = [];
const patch = (object, key, value) => { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; };
let clanId = 0;
const actor = (id, name, clan = 77) => ({ fetchId: () => id, fetchName: () => name, fetchLevel: () => 55,
    fetchClanId: () => clan, fetchClassId: () => 2, fetchIsOnline: () => true, isDead: () => false,
    fetchLocX: () => 10, fetchLocY: () => 20, fetchLocZ: () => 30, fetchHead: () => 0,
    unselect() {}, state: { fetchCasts: () => false }, automation: { abortAll() {} } });
const session = { actor: { ...actor(42, 'Slava'), fetchClanId: () => clanId }, dataSendToMe: p => packets.push(p) };
const members = [{ actor: actor(101, 'MainBot'), dataSendToMeAndOthers() {} }];
const config = { combatMode: 'assist', movementMode: 'follow', pullMode: 'auto', lootPickupEnabled: true };
let clan = { leaderId: 42, members: [{ id: 101 }, { id: 201 }, { id: 202 }, { id: 301 }] };
const states = [{ characterId: 201, name: 'ClanBot', level: 55 }, { characterId: 202, name: 'ClanCold', level: 55 },
    { characterId: 301, name: 'FriendBot', level: 55 }, { characterId: 401, name: 'Outsider', level: 55 }];
const friendRows = [{ botId: 301, name: 'FriendBot', level: 55, classId: 2, className: 'Gladiator', trust: 10, selected: true },
    { botId: 401, name: 'Outsider', level: 55, classId: 2, className: 'Gladiator', trust: 10 }];
function payload() {
    const packet = packets.at(-1); assert.equal(packet[0], 0x0f);
    let end = 5; while (packet.readUInt16LE(end)) end += 2;
    return packet.subarray(5, end).toString('utf16le');
}
function snapshot() {
    const value = payload(); assert(value.startsWith(Protocol.PREFIX) || value.startsWith(Protocol.PREFIX_V2)); assert(value.length <= 8192);
    const lines = value.split('\n').slice(1).map(line => line.split('\t'));
    return { state: lines[0], groups: lines.filter(r => r[0] === 'group'), rows: lines.filter(r => r[0] === 'row') };
}
function send(action, ...args) { const hub = session.partyHub; return Hub(session, ['native-party-hub', action, String(hub.epoch), String(hub.revision), ...args.map(String)]); }
function group(number, botId = 500 + number) {
    const owner = { actor: actor(botId, `Leader${number}`) };
    const g = { number, active: true, commander: session, commanderActor: session.actor, owner,
        leaderAssigned: true, members: new Set([owner]), movement: 'follow' };
    owner.clanCommandParty = g; owner.followPlayerSession = owner;
    session.commandParties ||= new Map(); session.commandParties.set(number, g);
    return g;
}
async function verifySorting() {
    const catalog = Finder.catalog, availability = Finder.availability;
    const entries = [[701,'Zed',60,'tank'],[702,'alpha',50,'tank'],[703,'Beta',70,'mage'],[704,'beta',70,'mage'],
        [705,'Delta',55,'tank'],[706,'Echo',65,'healer'],[707,'Foxtrot',69,'tank'],[708,'Gamma',64,'mage'],
        [709,'Hotel',68,'tank'],[710,'India',66,'tank'],[711,'Juliet',67,'tank'],[712,'Kilo',63,'tank'],
        [713,'Alfred',60,'tank',2],[714,'Alina',65,'mage']];
    Finder.catalog = () => [...entries].reverse().map(([id,name,level,role,clan]) => ({name,level,phase:'cold',subject:actor(id,name,clan),profession:{classId:2,className:'Test',role}}));
    Finder.availability = (_session, candidate) => ({available:candidate.name!=='alpha',reasonText:'Unavailable'});
    const originalMembers = clan.members;
    clan.members = entries.filter(e=>e[4]!==2).map(e=>({id:e[0]}));
    try {
        await Hub(session, ['native-party-hub','open','2','finder']);
        assert(payload().startsWith(Protocol.PREFIX_V2)); assert.equal(snapshot().state[28],'level_asc');
        const names = () => snapshot().rows.map(row=>row[2]);
        assert.deepEqual(names(), ['alpha','Delta','Alfred','Zed','Kilo','Gamma','Alina','Echo'], 'unavailable rows retain the selected level ordering');
        assert.equal(Number(snapshot().rows[0][7]) & Protocol.ACTION.INVITE, 0);
        await send('page',1); assert.deepEqual(names(), ['India','Juliet','Hotel','Foxtrot','Beta','beta']);
        await send('filter','-','all','all','level_desc');
        assert.equal(snapshot().state[8],'0'); assert.deepEqual(names(), ['Beta','beta','Foxtrot','Hotel','Juliet','India','Alina','Echo']);
        await send('filter','-','all','all','name_asc');
        assert.deepEqual(names(), ['Alfred','Alina','alpha','Beta','beta','Delta','Echo','Foxtrot']);
        const firstPageIds = snapshot().rows.map(row=>row[1]);
        await send('page',1); assert.deepEqual(names(), ['Gamma','Hotel','India','Juliet','Kilo','Zed']);
        assert.equal(new Set([...firstPageIds,...snapshot().rows.map(row=>row[1])]).size,14, 'ties have stable IDs across page boundaries');
        await send('filter','-','all','all','name_desc');
        assert.deepEqual(names(), ['Zed','Kilo','Juliet','India','Hotel','Gamma','Foxtrot','Echo']); fixtures.push(payload());
        await send('source','clan'); await send('filter','i','60-69','tank','name_desc');
        assert.deepEqual(names(), ['Kilo','Juliet','India'], 'name, level, role and clan filters compose with sorting');
        assert.equal(snapshot().state[10],'3'); assert.equal(snapshot().state[28],'name_desc'); fixtures.push(payload());
        await send('filter','i','60-69','tank','level_desc'); assert.deepEqual(names(), ['Juliet','India','Kilo']);
        await send('refresh'); assert.equal(snapshot().state[28],'level_desc');
        const before = packets.length;
        for (const args of [['i','60-69','tank','random'],['i','60-69','tank'],['i','60-69','tank','name_asc','extra']]) await send('filter',...args);
        assert.equal(packets.length,before,'malformed sort requests cannot alter filters');
        await Finder.open(session); assert.equal(session.partyHub.version,2,'aliases retain the negotiated version');
        assert(payload().startsWith(Protocol.PREFIX_V2));
        for (const alias of ['.b','.bf','.bp']) {
            Speak(session,new Send(0x38).writeS(alias).writeD(0).fetchBuffer(false));
            await new Promise(resolve=>setImmediate(resolve));
            assert.equal(session.partyHub.version,2,`${alias} retains V2 through the real chat route`);
            assert(payload().startsWith(Protocol.PREFIX_V2));
        }
        await Hub(session,['native-party-hub','open','1','finder']);
        assert(payload().startsWith(Protocol.PREFIX)); assert.equal(snapshot().state.length,28,'previous clients retain their original wire shape');
        assert.notEqual(names()[0],'alpha','previous client availability ranking is unchanged'); fixtures.push(payload());
    } finally {
        Finder.catalog=catalog; Finder.availability=availability; clan.members=originalMembers;
        await Hub(session,['native-party-hub','open','1','party']);
    }
}
async function main() {
    patch(Party, 'membersForLeader', s => s === session ? members : []);
    patch(Party, 'getSettings', () => config);
    patch(Party, 'updateSettings', (_s, values) => Object.assign(config, values));
    patch(Party, 'hasCapacity', () => true);
    patch(Party, 'holdParty', () => {
        members.forEach(m => { m.botStay = true; });
        return { ok: true };
    });
    patch(Manager, 'getBotStatus', () => ({ intent: 'idle' }));
    patch(Manager, 'botSay', () => {});
    patch(Manager, 'findSessionById', () => null);
    patch(invoke('GameServer/Bot/AI/BotRoles'), 'inferRole', () => 'dps');
    patch(invoke('GameServer/Bot/AI/BotRoles'), 'presentation', () => ({ classId: 2, role: 'dps', className: 'Gladiator' }));
    patch(Clans, 'findById', id => id === 77 ? clan : null);
    patch(invoke('GameServer/Bot/BotAI'), 'wakeup', () => {});
    patch(invoke('GameServer/Bot/AI/BotPvpTactics'), 'stop', () => {});
    patch(Life, 'cachedState', id => states.find(s => s.characterId === id));
    patch(Life, 'findByName', async name => states.find(s => s.name === name));
    patch(Friends, 'listWindowPage', async () => ({ rows: friendRows, hasNext: false }));
    patch(Friends, 'selectedCount', async () => 1);
    patch(Finder, 'catalog', () => [
        { name: 'ClanBot', level: 55, phase: 'hot', subject: actor(201, 'ClanBot'), profession: { classId: 2, className: 'Gladiator', role: 'dps' } },
        { name: 'ClanCold', level: 55, phase: 'cold', subject: states[1], profession: { classId: 2, className: 'Gladiator', role: 'dps' } },
        { name: 'Outsider', level: 55, phase: 'hot', subject: actor(401, 'Outsider', 2), profession: { classId: 2, className: 'Gladiator', role: 'dps' } }
    ]);
    patch(Finder, 'availability', () => ({ available: true, reasonText: 'available' }));
    let preset = { version: 1, main: [{ id: 101, name: 'MainBot' }], additional: [
        { leaderId: 201, members: [{ id: 201, name: 'ClanBot' }, { id: 202, name: 'ClanCold' }] } ] };
    patch(DB, 'fetchPartyPreset', async () => [{ rosterJson: JSON.stringify(preset) }]);
    await Hub(session, ['native-party-hub', 'order', '1', '1', 'combat', 'passive']);
    assert.equal(config.combatMode, 'assist', 'no orders without negotiation');
    await Hub(session, ['native-party-hub', 'open', '1', 'party']);
    let s = snapshot(); assert.equal(s.state[4], '0'); assert.equal(s.groups.length, 0);
    assert.equal(s.state[6], 'main'); fixtures.push(payload());
    for (const args of [['scope', 'all'], ['scope', 'new'], ['tab', 'saved'], ['source', 'clan']]) {
        const before = packets.length; await send(...args); assert.equal(packets.length, before, 'ordinary player cannot access clan actions');
    }
    await send('order', 'combat', 'passive'); assert.equal(config.combatMode, 'passive');
    await send('hold', 101); assert.equal(members[0].botStay, true);
    await send('follow', 101); assert.equal(members[0].botStay, false);
    const beforeInvalid = packets.length;
    await send('order', 'constructor', 'bad'); await send('hold', 999); assert.equal(packets.length, beforeInvalid);
    const stale = { ...session.partyHub }; await send('refresh');
    await Hub(session, ['native-party-hub', 'order', String(stale.epoch), String(stale.revision), 'combat', 'assist']);
    assert.equal(config.combatMode, 'passive', 'stale snapshot cannot issue an order');
    clanId = 77; clan.leaderId = 999; await send('refresh'); assert.equal(snapshot().state[4], '0', 'clan member is not commander');
    clan.leaderId = 42;
    for (let n = 1; n <= 11; n++) group(n);
    await send('refresh'); s = snapshot(); assert.equal(s.state[4], '1'); assert.equal(s.groups.length, 8); assert.equal(s.state[12], '2');
    await send('groups', 1); s = snapshot(); assert.equal(s.groups[0][1], 'main'); assert.equal(s.groups[1][1], 'p8'); fixtures.push(payload());
    await send('scope', 'p8'); await send('order', 'move', 'hold'); assert.equal(session.commandParties.get(8).movement, 'hold');
    await send('scope', 'all'); await send('order', 'move', 'hold');
    assert([...session.commandParties.values()].every(g => g.movement === 'hold')); assert(members.every(m => m.botStay));
    fixtures.push(payload());
    assert.equal(snapshot().groups[0][5], 'hold');
    await send('order', 'move', 'follow');
    assert(members.every(member => !member.botStay));
    assert.equal(snapshot().groups[0][5], 'follow', 'All parties Follow updates Main movement');
    await send('scope', 'main');
    assert.equal(snapshot().state[16], 'follow');
    await send('scope', 'p8'); await send('tab', 'recruit'); await send('source', 'clan');
    s = snapshot(); assert.equal(s.state[6], 'p8'); assert.deepEqual(s.rows.map(row => row[1]), ['201', '202'], 'both hot actors and cold states retain their character IDs');
    const beforeSearch = packets.length; await send('source', 'finder'); assert.equal(packets.length, beforeSearch);
    await send('filter', 'ClanCold', 'all', 'all'); assert.equal(snapshot().rows.length, 1); assert.equal(snapshot().rows[0][2], 'ClanCold');
    await send('filter', '-', 'all', 'all'); await send('source', 'friends');
    s = snapshot(); assert(s.rows[0][7] & Protocol.ACTION.INVITE); assert(!(s.rows[1][7] & Protocol.ACTION.INVITE));
    assert(!(s.rows[0][7] & Protocol.ACTION.CONST), 'additional party does not edit the main const selection');
    let invited = [];
    const inviteFriendByName = World.inviteFriendByName;
    patch(World, 'inviteFriendByName', async (_s, actor, name) => { assert.equal(actor, session.actor); invited.push(name); return true; });
    clan.leaderId = 999;
    await send('invite', 301);
    assert.deepEqual(invited, [], 'losing clan authority cannot silently retarget a p8 invitation into Main');
    clan.leaderId = 42;
    await send('scope', 'main'); await send('invite', 301); assert.deepEqual(invited, ['FriendBot']);
    let loadGroup;
    const listFriends = Friends.listWindowPage;
    Friends.listWindowPage = () => new Promise(resolve => { loadGroup = resolve; });
    const staleInvite = send('scope', 'p8');
    const clanInvites = [];
    const handleCommand = Commands.handleCommand;
    Commands.handleCommand = (_session, command) => clanInvites.push(command);
    try {
        await send('invite', 301);
        assert.deepEqual(clanInvites, [], 'Main snapshot cannot invite into p8 before the new revision is published');
        Friends.listWindowPage = listFriends;
        loadGroup({ rows: friendRows, hasNext: false });
        await staleInvite;
        await send('invite', 301);
        assert.deepEqual(clanInvites, ['.invite-p8 FriendBot'], 'a fresh p8 snapshot can invite into p8');
    } finally {
        Friends.listWindowPage = listFriends;
        Commands.handleCommand = handleCommand;
    }
    const originalEpoch = session.partyHub.epoch;
    await invoke('GameServer/World/Generics/NpcBypasses/BotFriends').render(session, 'add', 0, null, { open: true });
    assert(session.partyHub.epoch > originalEpoch); assert.equal(session.partyHub.source, 'add');
    session.botFriendsView = { mode: 'add', page: 0 };
    await invoke('GameServer/World/Generics/NpcBypasses/BotFriends').render(session, 'friends', 0, null, { open: true });
    assert.equal(session.partyHub.source, 'friends', 'the friends alias leaves a previous add view');
    await Finder.open(session); assert.equal(session.partyHub.source, 'finder');
    await Control.render(session, 0, { open: true }); assert.equal(session.partyHub.tab, 'party');
    for (const [alias, tab, source] of [['.bf', 'recruit', 'friends'], ['.bp', 'recruit', 'finder'], ['.b', 'party', 'finder']]) {
        Speak(session, new Send(0x38).writeS(alias).writeD(0).fetchBuffer(false));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(session.partyHub.tab, tab, `${alias} actual C4 Speak packet selects the expected tab`);
        assert.equal(session.partyHub.source, source);
    }
    await verifySorting();
    session.partyPresetOperation = {};
    await Hub.open(session,'party');assert.equal(snapshot().state[23],'1');fixtures.push(payload());
    delete session.partyPresetOperation;
    await send('refresh');assert.equal(snapshot().state[23],'0','explicit refresh recovers a completed external save without reopening');fixtures.push(payload());
    session.commandParties.get(1).owner.actor = actor(202, 'ClanCold');
    await send('tab', 'saved');
    assert.equal(snapshot().rows[1][10], '1', 'opening Saved counts an existing member before a restore');
    assert.equal(snapshot().rows[1][6], 'ClanBot');
    fixtures.push(payload());
    let saves = 0;
    patch(Presets, 'save', async () => { saves++; return { ok: true }; });
    patch(Presets, 'restore', async () => {
        session.commandParties.get(1).owner.actor = actor(201, 'ClanBot');
        return { ok: true, complete: false, unavailable: [{ id: 202, name: 'ClanCold' }] };
    });
    await send('save'); assert.equal(saves, 1); await send('restore');
    s = snapshot(); assert.equal(s.rows[1][6], 'ClanCold'); assert.equal(s.rows[1][10], '1'); assert.equal(s.rows[1][11], '2'); fixtures.push(payload());
    session.commandParties.get(1).owner.actor = actor(501, 'Leader1');
    await send('refresh'); assert.equal(snapshot().rows[1][10], '0', 'a missing leader does not imply the other saved members assembled');
    session.commandParties.get(1).owner.actor = actor(202, 'ClanCold');
    await send('refresh');
    assert.equal(snapshot().rows[1][10], '1', 'the restore report counts a saved member even without the original leader');
    assert.equal(snapshot().rows[1][6], 'ClanBot');
    session.commandParties.get(1).owner.actor = actor(501, 'Leader1');
    const originalPreset = preset;
    const manyMissing = Array.from({ length: 9 }, (_, index) => ({ id: 2001 + index, name: `UnavailableCompanion${index + 1}` }));
    preset = { ...preset, additional: [{ leaderId: manyMissing[0].id, members: manyMissing }] };
    await send('refresh');
    assert.equal(snapshot().rows[1][6], '9 missing. Restore lists names in chat.');
    assert.deepEqual(snapshot().rows[1].slice(10), ['0', '9']);
    fixtures.push(payload());
    preset = originalPreset;
    clan.leaderId = 999; await send('save'); assert.equal(saves, 1, 'authority is checked again at execution');
    await send('refresh'); assert.equal(snapshot().state[4], '0'); assert.equal(session.partyHub.scope, 'main'); assert.equal(session.partyHub.tab, 'party');
    clan.leaderId = 42;
    await send('tab', 'recruit'); await send('source', 'friends');
    Friends.listWindowPage = async (_owner, _source, page) => {
        if (page > 0) throw Error('fixture could not read the second page');
        return { rows: friendRows, hasNext: true };
    };
    await send('refresh');
    assert.equal(snapshot().state[9], '2');
    await send('page', 1);
    const failedPage = snapshot();
    assert.deepEqual(failedPage.state.slice(8, 10), ['0', '1']);
    assert.equal(failedPage.state[22], 'Could not load. Try Refresh.');
    assert.equal(failedPage.rows.length, 0);
    fixtures.push(payload());
    let finishRead;
    Friends.listWindowPage = () => new Promise(resolve => { finishRead = resolve; });
    const staleRead = send('refresh'); await Promise.resolve();
    await send('tab', 'party'); const newPagePackets = packets.length;
    finishRead({ rows: friendRows, hasNext: false }); await staleRead;
    assert.equal(packets.length, newPagePackets, 'late database read cannot replace a newer tab');
    Friends.listWindowPage = async () => ({ rows: friendRows, hasNext: false });
    await send('tab', 'recruit');
    patch(Friends, 'selected', async () => [{ characterName: 'FriendBot' }]);
    patch(invoke('GameServer/Bot/AI/ConstPartySession'), 'prepareFormation', async () => ({ rollback: async () => {} }));
    World.inviteFriendByName = async () => false;
    await send('form');
    assert.equal(snapshot().state[22], 'Party invitations processed: 0 / 1.');
    let finishInvite;
    World.inviteFriendByName = () => new Promise(resolve => { invited.push('pending'); finishInvite = resolve; });
    const invitation = send('invite', 301); await Promise.resolve(); await Promise.resolve();
    await send('invite', 301); assert.equal(invited.filter(n => n === 'pending').length, 1, 'duplicate invitation is serialized');
    await send('close'); const closed = packets.length; finishInvite(true); await invitation;
    assert.equal(packets.length, closed, 'closing during invitation cannot reopen the window');
    await Hub.open(session, 'party');
    const oldActor = session.actor; session.actor = actor(999, 'Other'); const otherPackets = packets.length;
    await send('order', 'combat', 'assist'); assert.equal(packets.length, otherPackets); assert.equal(config.combatMode, 'passive');
    session.actor = oldActor;
    await send('close'); await Control.render(session); assert.equal(packets.length, otherPackets, 'background events respect hidden state');
    World.inviteFriendByName = inviteFriendByName;
    let finishFriendCheck;
    patch(Friends, 'isFriend', () => new Promise(resolve => { finishFriendCheck = resolve; }));
    let attachedAfterReset = false;
    patch(World, 'inviteBotByName', async () => { attachedAfterReset = true; return true; });
    await Hub.open(session, 'friends');
    const teardownEpoch = session.partyHub.epoch;
    const pendingInvite = send('invite', 301);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finishFriendCheck, 'function');
    Friends.listWindowPage = () => new Promise(resolve => { finishRead = resolve; });
    const pendingRead = send('refresh');
    Reset.reset(session, { clearDirection: true });
    assert.equal(session.partyHubOperation, undefined);
    assert.equal(session.partyHub, undefined);
    assert.equal(session.partyHubEpoch, teardownEpoch);
    const afterReset = packets.length;
    await invoke('GameServer/World/Generics/NpcBypasses/CompanionControl').render(session);
    finishFriendCheck(true);
    finishRead({ rows: friendRows, hasNext: false });
    await Promise.all([pendingInvite, pendingRead]);
    assert.equal(attachedAfterReset, false, 'teardown cancels the invitation before replacing the actor');
    assert.equal(packets.length, afterReset, 'teardown drops the pending snapshot even while the actor is assigned');
    await Hub.open(session, 'party');
    assert(session.partyHub.epoch > teardownEpoch && session.partyHub.version === 1);
    await Hub(session, ['native-party-hub', 'open', '0']); assert(payload().includes('<title>Party Control</title>'), 'stock HTML fallback');
    const clean = Protocol.encode({ epoch: 1, revision: 1, tab: 'party', scope: 'main', source: 'friends',
        page: 0, pages: 1, total: 0, groupPage: 0, groupPages: 1, groupTotal: 1, selectedCount: 0,
        combat: 'assist', movement: 'follow', pull: 'auto', level: 'all', role: 'all' }, [], [
        { id: 1, name: 'Name\n\t\0X', detail: 'Class', note: 'a\nb' } ]);
    assert.equal(clean.split('\n').length, 3); assert(!clean.includes('\0'));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from(fixtures.join('\0'), 'utf16le'));
    console.log('Party hub: real bypass protocol, authority, hot/cold IDs, scoped orders, paging, aliases, saves, partial restore, serialization and lifecycle passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => restores.reverse().forEach(restore => restore()));
