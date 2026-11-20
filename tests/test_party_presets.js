'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-party-presets');
require('./helpers/databaseIsolation');
require('../src/Global');
fixture.assertConfigured(options.default);
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const markHot = Life.markHot;
const Manager = invoke('GameServer/Bot/BotManager'), World = invoke('GameServer/World/World');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService'), Commands = invoke('GameServer/Bot/AI/ClanCommandParty');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const AI = invoke('GameServer/Bot/BotAI'), Speak = invoke('GameServer/Network/Request/Speak');
const { registerSessions } = require('./helpers/worldSessions');
let Preset = invoke('GameServer/Bot/AI/PlayerPartyPreset');
const restores = [], messages = [], invitationNames = [];
function patch(object, key, value) { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; }
const query = (sql, params = []) => DB.execute([sql, params]);
const clan = { id: 77, leaderId: 9001, members: [] };
const mainIds = [201,202,203,204,205,206,207,208];
const extraIds = [[301,302,303,304,305,306,307,308,309],[401,402],[501]];
async function seed(id) {
    const account = id >= 9000 ? `player_preset_${id}` : `bot_preset_${id}`;
    await query('INSERT INTO accounts(username,password) VALUES (?,?)', [account,'test']);
    await query(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,hp,mp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (?,?,?,0,0,20,100,100,100,100,0,0,0,0,10,20,30,77)`, [id,account,`Char${id}`]);
    if (id >= 9000) return;
    clan.members.push({ id });
    await query(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,locX,locY,locZ,
        hp,maxHp,mp,maxMp,nextResolveAt,updatedAt,statsJson,inventorySummary)
        VALUES (?,?,?,20,'cold','hunting',10,20,30,100,100,100,100,?,?,'{}','{}')`, [id,account,`Char${id}`,Date.now()+60000,Date.now()]);
    Life.acceptLifecycleRow((await query('SELECT * FROM bot_life_state WHERE characterId=?',[id]))[0]);
}
function actor(id) {
    const value = { name:`Char${id}`, online:true, dead:false, fetchId:()=>id, fetchName:()=>value.name,
        fetchClanId:()=>77, fetchIsOnline:()=>value.online, fetchClassId:()=>0, fetchLevel:()=>20,
        fetchExp:()=>0, fetchSp:()=>0,
        fetchLocX:()=>10, fetchLocY:()=>20, fetchLocZ:()=>30, fetchHead:()=>0,
        fetchHp:()=>100, fetchMaxHp:()=>100, setHp() {}, fetchMp:()=>100, fetchMaxMp:()=>100, setMp() {},
        fetchCp:()=>100, fetchMaxCp:()=>100, isDead:()=>value.dead, refreshVitalsRegeneration() {}, moveTo() {}, unselect() {},
        attack:{ abortCast() {}, clearTimers() {}, resetQueuedEvent() {} },
        state:{ setHits() {}, setCasts() {}, fetchSeated:()=>false }, automation:{ abortAll() {}, stopReplenish() {} } };
    return value;
}
function session(id) {
    const result = { actor:actor(id), accountId:`player_preset_${id}`, dataSendToMe(packet) { if (typeof packet === 'string') messages.push(packet); },
        dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    result.actor.session = result;
    return result;
}
const sorted = rows => rows.map(member=>member.actor.fetchId()).sort((a,b)=>a-b);
const activeGroups = player => [...(player.commandParties?.values() || [])].filter(group=>group.active);
const release = player => Party.detachAll(player,{ source:'preset_fixture',rebuildWindow:false,refreshPanel:false });
function command(player,text) {
    Speak.consume(player,{kind:0,text});
    assert(player.partyPresetOperation,'chat commands route to the preset service even without a party');
    return player.partyPresetOperation.promise;
}
async function main() {
    DB.init(); await Life.init();
    for (const id of [9001,9002,...mainIds,...extraIds.flat(),601]) await seed(id);
    await query("INSERT INTO clans(id,name,level,leaderId) VALUES(77,'PresetClan',3,9001)");
    patch(invoke('GameServer/Clan/ClanService'),'findById',id=>id===77?clan:null);
    patch(Manager,'sessions',[]);
    patch(Manager,'botTell',()=>{}); patch(Manager,'botSay',()=>{});
    patch(invoke('GameServer/Network/Response'),'speak',(_actor,data)=>data.text);
    patch(invoke('GameServer/Bot/AI/BotSocialMemory'),'recordEvent',async()=>{});
    patch(invoke('GameServer/Social/InteractionMemoryRuntime'),'ensureMany',async()=>{ throw Error('clan recruitment must not await relationships'); });
    patch(AI,'stop',target=>{ target.aiActive=false; }); patch(AI,'wakeup',()=>{});
    patch(invoke('GameServer/Bot/AI/BotPvpTactics'),'stop',()=>{});
    patch(invoke('GameServer/Bot/AI/BotSupportPlanner'),'cancelSupportCast',()=>{});
    patch(invoke('GameServer/Bot/BotTradeService'),'cleanup',()=>{});
    patch(invoke('GameServer/Bot/AI/BotEventJournal'),'record',async()=>{});
    patch(invoke('GameServer/World/Generics/NpcBypasses/CompanionControl'),'render',()=>{});
    patch(Life,'markHot',async target=>Life.cachedState(target.actor.fetchId()));
    patch(Coordinator,'fenceBot',async()=>({ok:true})); patch(Coordinator,'releaseFence',()=>{});
    patch(Party,'bringToLeader',()=>true);
    patch(invoke('GameServer/Bot/Population/ActivationPlacement'),'resolve',()=>({loc:{locX:10,locY:20,locZ:30}}));
    let spawns = 0;
    patch(Manager,'loadAndSpawnBot',async(_account,data)=>{
        spawns++;
        const state = data.coldLifeState, target = session(state.characterId);
        Object.assign(target,{accountId:state.accountName,plan:'hunting',coldLifeState:state,aiActive:true});
        Manager.sessions.push(target);
        return target;
    });
    const invite = World.inviteBotByName;
    patch(World,'inviteBotByName',function(...args) { invitationNames.push(args[2]); return invite.apply(this,args); });
    let player = session(9001);
    const other = session(9002);
    registerSessions([player,other]);
    assert.equal(Preset.handleCommand(player,'.parties'),false);
    assert.equal((await Preset.restore(other)).reason,'not_clan_leader');
    assert.equal((await command(player,'.partyrestore')).ok,false,'a missing save does not assemble anything');
    for (const id of mainIds) assert(await World.inviteBotByName(player,player.actor,`Char${id}`));
    for (const ids of extraIds) {
        Commands.handleCommand(player,`.createparty Char${ids[0]}`);
        const group = activeGroups(player).at(-1); await group.pending;
        for (const id of ids.slice(1)) { Commands.handleCommand(player,`.invite-p${group.number} Char${id}`); await group.pending; }
    }
    Manager.findSessionById(208).actor.dead = true;
    const saved = await command(player,'.partysave');
    assert(saved.ok);
    assert.deepEqual(saved.roster.main.map(member=>member.id).sort((a,b)=>a-b),mainIds,'all eight main-party bots are saved');
    assert.deepEqual(saved.roster.additional.map(group=>group.members.map(member=>member.id)),extraIds,'every additional party includes its bot captain');
    const [persisted] = await DB.fetchPartyPreset(9001);
    assert.equal((await DB.fetchPartyPreset(9002)).length,0,'saves are owned by the character');
    release(player);
    assert.equal((await command(player,'.partysave')).ok,false,'an empty party cannot erase a saved composition');
    assert.equal((await DB.fetchPartyPreset(9001))[0].rosterJson,persisted.rosterJson);
    Manager.findSessionById(208).actor.dead = false;
    await DB.close(); DB.init();
    delete require.cache[require.resolve('../src/GameServer/Bot/AI/PlayerPartyPreset')];
    Preset = invoke('GameServer/Bot/AI/PlayerPartyPreset');
    assert.equal((await DB.fetchPartyPreset(9001))[0].rosterJson,persisted.rosterJson,'the composition survives reopening SQLite and reloading the service');
    player.actor.online = false;
    player = session(9001);
    registerSessions([player,other,...Manager.sessions]);
    Party.updateSettings(player,{lootPickupEnabled:false});
    const reportStart = messages.length;
    let result = await command(player,'.partyrestore');
    assert(result.complete);
    assert.deepEqual(sorted(Party.membersForLeader(player)),mainIds);
    assert.deepEqual(activeGroups(player).map(group=>sorted(Commands.roster(group))),extraIds);
    assert(activeGroups(player).every(group=>Party.getSettings(group.owner).lootPickupEnabled===false),'restore preserves the main loot policy');
    for (const group of activeGroups(player)) assert(messages.slice(reportStart).includes(
        `Additional party ${group.number}: ${Commands.roster(group).length}/${Commands.roster(group).length}.`),
    'restore reports the actual command-party number after previous groups were dismissed');

    // Spawned/released companions explicitly clear craft snapshots to null.
    // Exercise their real hot checkpoint rather than the fixture's shortcut.
    const returningIds = new Set([207,208,302]);
    for (const id of returningIds) {
        const target = Manager.findSessionById(id);
        const owner = target.followPlayerSession;
        Party.detach(owner,target,{rebuildWindow:false,refreshPanel:false});
        target.coldCraftState = null;
        target.coldMarketState = null;
    }
    const fixtureMarkHot = Life.markHot;
    patch(Life,'markHot',function(target,...args) {
        return (returningIds.has(target.actor.fetchId()) ? markHot : fixtureMarkHot).call(this,target,...args);
    });
    result = await command(player,'.partyrestore');
    assert(result.complete,'two main-party members and one additional-party member with null craft snapshots rejoin');
    assert.deepEqual(result.unavailable,[]);
    assert.deepEqual(sorted(Party.membersForLeader(player)),mainIds);
    assert.deepEqual(activeGroups(player).map(group=>sorted(Commands.roster(group))),extraIds);
    restores.pop()();

    const calls = invitationNames.length, spawnCount = spawns;
    assert((await command(player,'.partyrestore')).complete);
    assert.equal(invitationNames.length,calls,'repeat restore makes no duplicate native invitations');
    assert.equal(spawns,spawnCount);
    const first = activeGroups(player)[0];
    Commands.handleCommand(player,`.leader-p${first.number} Char302`);
    assert.equal(first.owner.actor.fetchId(),302);
    assert((await command(player,'.partyrestore')).complete);
    assert.equal(first.owner.actor.fetchId(),301,'restore reinstates the saved captain without replacing the group');
    assert.equal(invitationNames.length,calls);

    const renamed = Manager.findSessionById(208);
    Party.detach(player,renamed,{rebuildWindow:false,refreshPanel:false});
    renamed.actor.name = 'Renamed208';
    await query('UPDATE characters SET name=? WHERE id=?',['Renamed208',208]);
    await query('UPDATE bot_life_state SET characterName=? WHERE characterId=?',['Renamed208',208]);
    Life.acceptLifecycleRow((await query('SELECT * FROM bot_life_state WHERE characterId=?',[208]))[0]);
    assert((await command(player,'.partyrestore')).complete);
    assert(invitationNames.includes('Renamed208'),'restore looks up current names by persistent character ID');

    Commands.handleCommand(player,`.kick-p${first.number} Char309`);
    const normalInvite = World.inviteBotByName;
    patch(World,'inviteBotByName',function(...args) { return args[2]==='Char309'?Promise.resolve(false):normalInvite.apply(this,args); });
    result = await command(player,'.partyrestore');
    assert.equal(result.complete,false);
    assert(result.unavailable.some(member=>member.id===309));
    assert.deepEqual(sorted(Party.membersForLeader(player)),mainIds);
    restores.pop()();
    assert((await command(player,'.partyrestore')).complete,'a repeated restore retries only missing members');

    Commands.handleCommand(player,`.leader-p${first.number} Char302`);
    Commands.handleCommand(player,`.kick-p${first.number} Char301`);
    const beforeCaptainRefusal = World.inviteBotByName;
    patch(World,'inviteBotByName',function(...args) { return args[2]==='Char301'?Promise.resolve(false):beforeCaptainRefusal.apply(this,args); });
    const captainReportStart = messages.length;
    result = await command(player,'.partyrestore');
    assert.equal(result.complete,false);
    assert.equal(result.additional.find(group=>group.leaderId===301).count,8,'an unavailable saved captain leaves the eight current members counted');
    assert(messages.slice(captainReportStart).includes(`Additional party ${first.number}: 8/9.`));
    assert.deepEqual(Preset.describe(player, saved.roster)[1].missing.map(member => member.id), [301]);
    restores.pop()();
    assert((await command(player,'.partyrestore')).complete);

    Commands.dismiss(activeGroups(player).find(group=>group.owner.actor.fetchId()===501));
    const beforeLeaderRefusal = World.inviteBotByName;
    patch(World,'inviteBotByName',function(...args) { return args[2]==='Char501'?Promise.resolve(false):beforeLeaderRefusal.apply(this,args); });
    result = await command(player,'.partyrestore');
    assert.equal(result.complete,false);
    assert(result.unavailable.some(member=>member.id===501&&member.reason==='leader_unavailable'));
    assert.equal(activeGroups(player).length,2,'an unavailable captain does not dissolve the other restored parties');
    assert(messages.includes('Additional party (Char501): 0/1.'),'an uncreated party is identified by its saved captain without inventing a command number');
    restores.pop()();
    assert((await command(player,'.partyrestore')).complete,'a missing captain and its party can be retried later');

    for (const change of ['member', 'captain']) {
        Commands.dismiss(activeGroups(player).find(group=>group.owner.actor.fetchId()===501));
        let entered, resume;
        const reached = new Promise(resolve=>{entered=resolve;});
        const gate = new Promise(resolve=>{resume=resolve;});
        const beforeInvite = World.inviteBotByName;
        patch(World,'inviteBotByName',async function(...args) {
            if (args[2]==='Char501') { entered(); await gate; }
            return beforeInvite.apply(this,args);
        });
        const restoring = command(player,'.partyrestore');
        await reached;
        Commands.handleCommand(player,change==='member' ? `.kick-p${first.number} Char309` : `.leader-p${first.number} Char302`);
        resume();
        const changed = await restoring;
        restores.pop()();
        assert.equal(changed.complete,false,'the final result must reflect a party changed while a later party was assembling');
        const reported = changed.additional.find(group=>group.leaderId===301);
        assert.equal(reported.complete,false,'a changed member or captain cannot be reported as a completed party');
        if (change==='member') {
            assert.equal(reported.count,8);
            assert(changed.unavailable.some(member=>member.id===309));
        }
        assert((await command(player,'.partyrestore')).complete,'retry repairs the concurrently changed party');
    }

    Commands.dismiss(first);
    const inviteWithoutCaptain = World.inviteBotByName;
    patch(World,'inviteBotByName',function(...args) { return args[2]==='Char301'?Promise.resolve(false):inviteWithoutCaptain.apply(this,args); });
    const fullReportStart = messages.length;
    result = await command(player,'.partyrestore');
    assert.equal(result.complete,false);
    const missingGroup = extraIds[0].map(id => `Char${id}`).join(', ');
    assert(missingGroup.length > 64);
    assert(messages.slice(fullReportStart).some(message => message.includes(missingGroup)), 'chat lists the entire group when the Saved row cannot fit every name');
    assert(extraIds[0].every(id => result.unavailable.some(member => member.id === id)));
    restores.pop()();
    assert((await command(player,'.partyrestore')).complete);

    const second = activeGroups(player).find(group => group.owner.actor.fetchId() === 401);
    Commands.handleCommand(player,`.kick-p${second.number} Char402`);
    await query('DELETE FROM characters WHERE id=?',[402]);
    result = await command(player,'.partyrestore');
    assert.equal(result.complete,false);
    assert(result.unavailable.some(member=>member.id===402&&member.reason==='character_missing'));
    assert(messages.some(message=>message.includes('Char402')&&message.includes('retry')));

    Party.detach(player,renamed,{rebuildWindow:false,refreshPanel:false});
    assert(await World.inviteBotByName(player,player.actor,'Char601'));
    const conflictCalls = invitationNames.length;
    assert.equal((await command(player,'.partyrestore')).ok,false);
    assert.equal(invitationNames.length,conflictCalls,'a conflicting main roster is refused before mutations');
    assert(Party.membersForLeader(player).some(member=>member.actor.fetchId()===601));
    Party.detach(player,Manager.findSessionById(601),{rebuildWindow:false,refreshPanel:false});

    async function cancelPending(name, change) {
        release(player);
        let entered, resume;
        const reached = new Promise(resolve=>{entered=resolve;});
        const gate = new Promise(resolve=>{resume=resolve;});
        const beforeInvite = World.inviteBotByName;
        patch(World,'inviteBotByName',async function(...args) {
            if (args[2]===name) { entered(); await gate; }
            return beforeInvite.apply(this,args);
        });
        const restoring = command(player,'.partyrestore');
        await reached;
        assert.equal((await Preset.restore(player)).reason,'busy');
        assert.equal((await Preset.save(player)).reason,'busy');
        change(); resume();
        assert.equal((await restoring).reason,'cancelled');
        restores.pop()();
        assert.equal(Party.membersForLeader(player).length,0);
        assert.equal(activeGroups(player).length,0);
        assert.equal(player.partyPresetOperation,undefined);
    }
    await cancelPending('Char201',()=>World.dismissParty(player));
    await cancelPending('Char301',()=>World.dismissParty(player));
    await cancelPending('Char201',()=>{player.actor.online=false;});
    player.actor.online=true;
    await cancelPending('Char201',()=>{player.actor=actor(9001);});

    result = await command(player,'.partyrestore');
    assert.equal(result.ok,true);
    assert.equal(result.complete,false,'the deleted character remains missing after cancellation and retry');
    Commands.dismissAll(player);
    const mainOnly = await command(player,'.partysave');
    assert(mainOnly.ok);
    assert.equal(mainOnly.roster.additional.length,0,'a later save replaces the entire composition');
    release(player);
    assert((await command(player,'.partyrestore')).complete,'a main-only save restores from a solo session');
    assert.equal(activeGroups(player).length,0);
    release(player);
    await DB.savePartyPreset(9002,mainOnly.roster);
    await query('DELETE FROM characters WHERE id=?',[9001]);
    assert.equal((await DB.fetchPartyPreset(9001)).length,0,'character deletion cascades to its saved composition');
    assert.equal((await DB.fetchPartyPreset(9002)).length,1,'deleting one owner leaves another character save intact');

    await DB.close();
    const legacy = new (require('node:sqlite').DatabaseSync)(fixture.world);
    legacy.exec("DROP TABLE character_party_presets; DELETE FROM named_migrations WHERE name='character-party-presets'");
    legacy.close();
    DB.init();
    assert.equal((await query("SELECT name FROM named_migrations WHERE name='character-party-presets'")).length,1);
    assert.equal((await DB.fetchPartyPreset(9002)).length,0,'an older database gains the saved-party table on startup');
    console.log('Party presets: native chat save/restore, full main and three extra parties, persistence, IDs/renames, partial retries, conflicts, cancellation, ownership and migration passed');
}
main().catch(error=>{ console.error(error); process.exitCode=1; }).finally(async()=>{
    for (const target of Manager.sessions) { target.partyCompanion=false; target.followPlayerSession=null; }
    restores.reverse().forEach(restore=>restore());
    await DB.close();
    fs.rmSync(fixture.directory,{recursive:true,force:true});
});
