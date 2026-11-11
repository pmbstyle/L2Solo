'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-full-raid');
require('../src/Global'); isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
// This fixture tests physical opening/ownership, not boss strength. Both cold
// and hot paths use the same small native boss without authored guard waves.
Data.npcs.push({ ...structuredClone(Data.npcs.find(npc => npc.selfId === 10137)), selfId: 9900137,
    template: { kind: 'Boss', name: 'Opening fixture', level: 50, raidBoss: true },
    stats: { pAtk: 1, mAtk: 1, pDef: 1000, mDef: 1000, atkSpd: 278, accur: 1 },
    vitals: { maxHp: 1000, maxMp: 1000, revHp: 0, revMp: 0 } });
const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState'), Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile'), Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Roster = require('../src/GameServer/Clan/ClanRaidRoster');
const Requests = require('../src/GameServer/Bot/Population/PartyRequestPlanner');
const Assembly = require('../src/GameServer/Bot/Population/PartyHuntingAssembly');
const Lifecycle = require('../src/GameServer/Bot/Population/HotPartyLifecycle');
const Hot = require('../src/GameServer/Bot/AI/HotBackgroundParty');
const World = invoke('GameServer/World/World'), Index = invoke('GameServer/World/RaidEntityIndex');
const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog'), Scope = invoke('GameServer/RaidBoss/RaidEncounterScope');
const Runtime = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const helperMode = process.argv.includes('--helpers');
const base = 840000, ids = Array.from({ length: helperMode ? 10 : 9 }, (_, i) => base + i);
const spot = { id: 'raid:full-fixture', avgLevel: 50, raidBoss: true, raidBossTemplateId: 9900137,
    raidInstanceId: 'full-instance', raidWorldAvailable: true, raidAuthorityRevision: 0 };
function body(id, classId, skills = []) {
    const state = { characterId: id, classId, clanId: 0, level: 50, phase: 'cold', activity: 'grouped', spotId: spot.id,
        accountName: 'bot_pop_full', loc: { locX: 0, locY: 0, locZ: 0 }, inventory: {},
        stats: { generatedCold: true, classId, coldCombat: { version: Combat.PROFILE_VERSION, classId,
            skillSource: 'database', skills: Combat.skillSnapshotsFromRecords(skills) } } };
    for (const slot of [7, 14, 8, 6, 9, 10, 11, 12]) {
        if (slot === 14 && Object.values(state.inventory).some(row => row.slot === 7)) continue;
        const item = Data.items.find(row => row.etc?.slot === slot && row.etc?.rank === 'c' && Gear.suitable(row, state, Gear.roleFor(state), 'c'));
        if (item) state.inventory[item.selfId] = { selfId: item.selfId, slot, amount: 1, equipped: true };
    }
    for (const selfId of [1463, 1464, 2511]) state.inventory[selfId] = { selfId, amount: 100000, stackable: true };
    return state;
}
const seeded = [body(base, 4), body(base + 1, 17, [{ selfId: 1068, level: 1 }]), body(base + 2, 15, [{ selfId: 1015, level: 1 }]),
    ...[7, 9, 10, 21, 0, 9].map((classId, i) => body(base + 3 + i, classId))];
if (helperMode) seeded.push(body(base + 9, 9));
const seed = new DatabaseSync(isolated.world);
seed.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
seed.exec("INSERT INTO accounts(username,password) VALUES('bot_pop_full','fixture')");
for (const member of seeded) {
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES(?,'bot_pop_full',?,?,0,50,?,500,300,0,0,0,0,0,0,0)`).run(member.characterId, `Full${member.characterId}`, member.classId, Number(Data.experience[49]));
    for (const skill of member.stats.coldCombat.skills) seed.prepare(`INSERT INTO skills(characterId,selfId,name,passive,level)
        VALUES(?,?,?,0,?)`).run(member.characterId, skill.selfId, `Fixture skill ${skill.selfId}`, skill.level);
    seed.prepare(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,exp,phase,activity,spotId,hp,maxHp,mp,maxMp,
        inventorySummary,statsJson,updatedAt) VALUES(?,'bot_pop_full',?,50,?,'cold','hunting',?,500,500,300,300,?,?,?)`)
        .run(member.characterId, `Full${member.characterId}`, Number(Data.experience[49]), spot.id, JSON.stringify(member.inventory), JSON.stringify(member.stats), Date.now());
}
seed.close();
const query = (sql, args = []) => Database.execute([sql, args]);
const old = { find: Catalog.findById, project: Scope.projectSource, contains: invoke('GameServer/Bot/AI/SpotService').containsLocation,
    registered: World.registeredActorById, boss: Index.bossByTemplateId, snapshot: Life.partySessionSnapshot };
let marker, goal, party;
async function refreshed() { return Life.statesByIds(ids); }
const owner = () => Database.clanRaidOwner(marker);
const admission = members => Roster.admission(party, members, spot, { owner: owner(), arrived: Assembly.ready(party, members, spot) });
function nativeSessions(states) {
    const Actor = invoke('GameServer/Actor/Actor'), Item = invoke('GameServer/Item/Item');
    return states.map(state => {
        const session = { hotBackgroundPartyId: party.partyId, persistenceMode: 'ephemeral', hennas: state.stats?.hennas || [null,null,null],
            accountId: 'raid-fixture', dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
        const actor = new Actor(session, { id: state.characterId, name: state.name, title: '', classId: state.classId, clanId: marker.clanId,
            level: state.level, exp: state.exp, sp: state.sp, race: 0, sex: 0, head: 0, isOnline: true,
            hp: 500, maxHp: 500, mp: 1000, maxMp: 1000, cp: 0, maxCp: 0, locX: 0, locY: 0, locZ: 0,
            str: 40, dex: 30, con: 40, int: 30, wit: 20, men: 30, pAtk: 500, mAtk: 500, pDef: 500, mDef: 500,
            atkSpd: 333, castSpd: 333, accur: 100, evasion: 20, crit: 0, radius: 8, size: 20, height: 20,
            runSpd: 120, walkSpd: 60, maxLoad: 10000, face: 0, hair: 0, hairColor: 0, isGM: false, items: [], paperdoll: {} });
        actor.backpack.paperdoll = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [i, { id: 0, selfId: 0 }]));
        actor.backpack.items = Object.values(state.inventory).map((row, i) => {
            const definition = Data.items.find(item => item.selfId === row.selfId);
            return new Item(state.characterId * 100 + i, { ...definition.template, ...definition.stats, ...definition.etc, ...row });
        });
        actor.skillset.populateSnapshot(state.stats.coldCombat.skills);
        invoke('GameServer/Actor/Generics').calculateStats(session, actor);
        actor.setHp(actor.fetchMaxHp()); actor.setMp(actor.fetchMaxMp());
        actor.automation.replenishVitals = () => {};
        actor.automation.stopReplenish = () => {};
        session.actor = actor;
        return session;
    });
}
async function nativeImpactCases(sessions, registry) {
    const Npc = invoke('GameServer/Npc/Npc'), Formulas = invoke('GameServer/Formulas');
    const Statements = require('../src/DatabaseStatements');
    const original = { boss: Index.bossByTemplateId, snapshot: Life.partySessionSnapshot, capture: Combat.capture,
        prepare: Statements.prepare, remove: World.removeNpc, user: World.user,
        experience: invoke('GameServer/Actor/Generics').experienceReward, hitChance: Formulas.calcHitChance };
    let captures = 0, fullCaptures = 0, ownerReads = 0, openingWrites = 0, loot = 0, experience = 0, goalCompletion;
    const boss = new Npc(998877, { selfId: marker.npcId, raidBoss: true, kind: 'Boss', name: 'Impact boss', title: '',
        level: 50, maxHp: 1000, maxMp: 1000, hp: 1000, mp: 1000, locX: 20, locY: 0, locZ: 0, head: 0,
        radius: 8, size: 20, height: 20, atkSpd: 333, runSpd: 120, walkSpd: 60,
        revHp: 0, revMp: 0, pDef: 10, mDef: 10, pAtk: 10, exp: 100, sp: 1 });
    boss.raidInstanceId = marker.raidInstanceId;
    boss.broadcastVitals = () => {};
    boss.canEngageCombat = () => false; // No world movement/timer in this isolated action fixture.
    boss.automation.replenishVitals = () => {};
    boss.automation.stopReplenish = () => {};
    Index.bossByTemplateId = () => boss;
    Formulas.calcHitChance = () => true;
    await Database.setSkill({ selfId: 1184, name: 'Ice Bolt', level: 1 }, sessions[5].actor.fetchId());
    await Database.setSkill({ selfId: 1015, name: 'Heal', level: 1 }, sessions[1].actor.fetchId());
    sessions[5].actor.skillset.populateSnapshot([{ selfId: 1184, level: 1 }]);
    sessions[1].actor.skillset.populateSnapshot([{ selfId: 1068, level: 1 }, { selfId: 1015, level: 1 }]);
    World.user = { sessions };
    Combat.capture = (...args) => { captures++; return original.capture(...args); };
    Life.partySessionSnapshot = (...args) => { fullCaptures++; return original.snapshot(...args); };
    Statements.prepare = (connection, sql, ...args) => {
        if (sql.includes('AS markerJson') || sql.includes('AS reserved')) ownerReads++;
        if (sql.startsWith('UPDATE bot_background_parties SET statsJson=?,updatedAt=?')) openingWrites++;
        return original.prepare(connection, sql, ...args);
    };
    World.removeNpc = () => {
        loot++;
        sessions[0].fixtureLoot = (sessions[0].fixtureLoot || 0) + 1;
        goalCompletion = Database.updateAutonomousClanGoal({ clanId: marker.clanId, ownerSection: marker.ownerSection,
            goal: { ...goal, status: 'completed' } });
    }; // Controlled corpse/drop leaf; native ReceivedHit/Die/NpcDied/EXP still execute.
    invoke('GameServer/Actor/Generics').experienceReward = (...args) => { experience++; return original.experience(...args); };
    const resetCounts = () => { captures = 0; fullCaptures = 0; ownerReads = 0; openingWrites = 0; };
    async function freshParty(label) {
        const [current] = await query('SELECT * FROM bot_background_parties WHERE partyId=?', [party.partyId]);
        if (current) party = Parties.acceptRow(current);
        if (party?.status === 'hot') await phase('cold');
        if (party && ['active', 'hot'].includes(party.status)) {
            party = await Parties.createOrUpdate({ ...party, status: 'dissolved', nextResolveAt: null }); assert(party);
        }
        if (party?.status === 'dissolved') await Life.releaseDissolvedPartyMembers(party.partyId, 'raid_defeated');
        await Database.updateAutonomousClanGoal({ clanId: marker.clanId, ownerSection: marker.ownerSection, goal });
        const members = await refreshed(), prepared = Parties.prepareCommit({ partyId: `impact-${label}`, leaderId: base,
            memberIds: ids, spotId: spot.id, status: 'active', startedAt: Date.now(), nextResolveAt: Date.now() + 30000,
            stats: { objective: { ...members[0].stats.clanPartyObjective, sourceKind: 'raid', raidBoss: true,
                raidBossTemplateId: marker.npcId, npcId: marker.npcId, minPartySize: ids.length, maxPartySize: ids.length, fullRoster: marker } } });
        // Native release completed professions in these level50 fixtures.
        // Spawn the actual current canonical classes, rather than old actors.
        sessions.forEach(session => session.actor.setClassId(members.find(member => member.characterId === session.actor.fetchId()).classId));
        const assigned = members.map(member => Life.preparePartyAssignment(member, prepared.row.partyId, Gear.roleFor(member), base, Date.now() + 30000));
        const formed = await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
        assert(formed.ok);
        Life.acceptPartyAssignments(assigned, formed.lifeRows); party = Parties.acceptRow(formed.partyRow); await phase('hot');
        sessions.forEach(session => { session.hotBackgroundPartyId = party.partyId; session.actor.state.setCasts(false); session.actor.state.setHits(false); });
        boss.setHp(1000); boss.state.setDead(false); boss.setDestId(base); boss.raidInstanceId = marker.raidInstanceId;
        const opened = await Lifecycle.openMarkedRaid(party, sessions);
        assert(opened.ok, opened.reason); party = opened.party; assert(!Roster.held(party));
        resetCounts();
    }
    function queuedMelee() {
        const actor = sessions[0].actor, attack = actor.attack, timers = [];
        actor.state.setHits(false);
        attack.queueTimer = callback => { timers.push(callback); return null; };
        attack.prepareMeleeHit = () => ({ damage: 10, flags: 0 });
        attack.meleeHit(sessions[0], boss);
        assert(timers.length >= 2, 'actual native melee dispatch queues impact and repeat');
        return timers[0];
    }
    async function denied(label, change, restore) {
        const impact = queuedMelee(), beforeHp = boss.fetchHp(), before = party.stats.raidAdmission;
        await change(); impact();
        assert.equal(boss.fetchHp(), beforeHp, `${label}: queued attack cannot damage after input change`);
        assert.deepEqual(Parties.find(party.partyId).stats.raidAdmission, before, `${label}: no earned opening`);
        assert(!Roster.held(Parties.find(party.partyId)), label);
        await restore();
    }
    try {
        await freshParty('melee');
        const recovering = sessions[2], recoveringMp = recovering.actor.fetchMp();
        recovering.actor.setMp(recovering.actor.fetchMaxMp() * 0.2);
        Hot.tick(recovering, recovering.actor, invoke('GameServer/Actor/Generics'), {});
        assert.equal(recovering.lastDecision.action, 'raid_recovery', 'a visible admitted healer sits before the first attack');
        assert(recovering.actor.state.fetchSeated());
        assert.equal(recovering.actor.fetchMp(), recovering.actor.fetchMaxMp() * 0.2, 'recovery uses native regeneration, not a free refill');
        assert(!Roster.held(Parties.find(party.partyId)));
        recovering.actor.setMp(recoveringMp); recovering.actor.state.setSeated(false);
        sessions[0].raidOpenedBossId = boss.fetchId();
        assert(!Roster.nativeHotStarted(party), 'defensive autoaggro/tactical flag does not earn opening');
        sessions.forEach(session => { session.actor.state.setCasts(true); Hot.tick(session, session.actor, invoke('GameServer/Actor/Generics'), {}); });
        sessions.forEach(session => session.actor.state.setCasts(false));
        assert.equal(captures, 0, 'nine admitted AI ticks do not capture nine combat profiles each');
        assert.equal(fullCaptures, 0); assert.equal(ownerReads, 0);
        // A real support skill landing is not an offensive executor event.
        const healer = sessions[2], healTimers = [];
        healer.actor.attack.queueTimer = callback => { healTimers.push(callback); return null; };
        healer.actor.attack.remoteHit(healer, healer.actor, healer.actor.skillset.fetchSkill(1015));
        healTimers.at(-1)(); assert(!Roster.held(Parties.find(party.partyId))); assert.equal(openingWrites, 0);
        // The real heal refreshes native maxima in this compact actor fixture.
        // Recover those vitals before testing unrelated first-impact races.
        sessions.forEach(session => { session.actor.setHp(session.actor.fetchMaxHp()); session.actor.setMp(session.actor.fetchMaxMp()); });
        await denied('logout ninth', () => registry.delete(base + 8), () => registry.set(base + 8, { actor: sessions[8].actor, session: sessions[8] }));
        if (helperMode) await denied('helper logout', () => registry.delete(base + 9),
            () => registry.set(base + 9, { actor: sessions[9].actor, session: sessions[9] }));
        await denied('party change', () => { sessions[8].hotBackgroundPartyId = 'foreign'; }, () => { sessions[8].hotBackgroundPartyId = party.partyId; });
        await denied('membership race', () => query('UPDATE characters SET clanId=0 WHERE id=?', [base + 8]),
            () => query('UPDATE characters SET clanId=? WHERE id=?', [marker.clanId, base + 8]));
        await denied('canonical class race', () => query('UPDATE characters SET classId=21 WHERE id=?', [base + 2]),
            () => query('UPDATE characters SET classId=? WHERE id=?', [sessions[2].actor.fetchClassId(), base + 2]));
        await denied('source replacement', () => { boss.raidInstanceId = 'new-instance'; }, () => { boss.raidInstanceId = marker.raidInstanceId; });
        await denied('owner replacement', () => query("UPDATE clan_simulation_clans SET stateJson=json_set(stateJson,'$.productionGoal.fullRoster.generation','other') WHERE clanId=?", [marker.clanId]),
            () => query("UPDATE clan_simulation_clans SET stateJson=json_set(stateJson,'$.productionGoal.fullRoster.generation',?) WHERE clanId=?", [marker.generation, marker.clanId]));
        const item = sessions[8].actor.backpack.fetchItems()[0], enchant = item.fetchEnchantLevel();
        await denied('gear race', () => item.setEnchantLevel(enchant + 1), () => item.setEnchantLevel(enchant));
        const support = sessions[2].actor, manaBefore = support.fetchMp(), hpBefore = support.fetchHp();
        await denied('MP spent after admission', () => support.setMp(support.fetchMaxMp() * 0.2), () => support.setMp(manaBefore));
        await denied('HP lost after admission', () => support.setHp(support.fetchMaxHp() * 0.5), () => support.setHp(hpBefore));
        const learned = healer.actor.skillset.skills;
        await denied('learned capability race', () => { healer.actor.skillset.skills = []; }, () => { healer.actor.skillset.skills = learned; });
        await denied('arrival race', () => sessions[8].actor.setLocX(5000), () => sessions[8].actor.setLocX(0));
        await query('BEGIN');
        try { await denied('raw transaction busy', () => {}, () => {}); }
        finally { await query('ROLLBACK'); }
        const impact = queuedMelee(), pendingWrite = query('UPDATE bot_life_state SET sp=sp+1 WHERE characterId=?', [base]);
        impact(); assert.equal(boss.fetchHp(), 1000, 'pending SQL writer defers native opening'); await pendingWrite;
        await query(`CREATE TEMP TRIGGER fail_marked_impact BEFORE UPDATE OF statsJson ON bot_background_parties
            WHEN NEW.partyId='impact-melee' BEGIN SELECT RAISE(ABORT,'injected marked opening rollback'); END`);
        await denied('native transaction rollback', () => {}, () => query('DROP TRIGGER fail_marked_impact'));
        resetCounts(); queuedMelee()(); party = Parties.find(party.partyId);
        assert.equal(boss.fetchHp(), 990, 'actual9 native melee impact deals damage');
        assert(Roster.nativeHotStarted(party)); assert.equal(openingWrites, 1);
        assert.equal(captures, ids.length, 'one compact pass for the opening event'); assert.equal(fullCaptures, 0); assert.equal(ownerReads, 2);
        const heldProof = structuredClone(party.stats.raidAdmission);
        const heldMana = sessions[2].actor.fetchMp();
        sessions[2].actor.setMp(sessions[2].actor.fetchMaxMp() * 0.2);
        registry.delete(base + 8); queuedMelee()(); registry.set(base + 8, { actor: sessions[8].actor, session: sessions[8] });
        sessions[2].actor.setMp(heldMana);
        assert.equal(boss.fetchHp(), 980, 'legitimate post-opening departure does not require nine alive again');
        assert.equal(captures, ids.length); assert.equal(ownerReads, 2); assert.equal(openingWrites, 1);
        if (helperMode) {
            const helper = sessions[9], previousState = helper.coldLifeState;
            helper.coldLifeState = (await refreshed()).find(state => state.characterId === base + 9);
            helper.actor.setHp(0); helper.actor.state.setDead(true);
            const casualty = await Lifecycle.failRaidOnDeath(helper);
            assert(casualty.continued, 'a native helper death does not end the core attempt');
            assert.notEqual(Parties.find(party.partyId).stats.raidEncounter?.status, 'failed');
            helper.actor.state.setDead(false); helper.actor.setHp(helper.actor.fetchMaxHp());
            helper.hotRaidCasualtyAt = null; helper.coldLifeState = previousState;
            assert.equal(Hot.partyRoster(helper).length, 1, 'native party skills see the helper subgroup');
            assert.equal(Hot.partyRoster(sessions[0]).length, 9, 'main party skills retain the core');
            const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
            const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
            const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
            const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
            const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
            const Spots = invoke('GameServer/Bot/AI/SpotService');
            const Travel = invoke('GameServer/Bot/AI/BotSpotTravel');
            const Town = invoke('GameServer/Bot/AI/TownTransitPolicy');
            const saved = { support: Tactics.support, incoming: Awareness.npcThreateningActor,
                legal: Safety.canEngageBotClanRaid, protected: Safety.isProtectedRaidEntity,
                combat: Revival.partyCombatInProgress, profile: Profiles.findById, contains: Spots.containsLocation,
                start: Travel.start, town: Town.townAt, plan: Safety.botClanRaidCombatPlan, helperX: helper.actor.fetchLocX() };
            const targets = [];
            try {
                Tactics.support = (session, _actor, context) => {
                    targets.push({ caster: session.actor.fetchId(), owner: context.owner.actor.fetchId(),
                        members: context.members.map(member => member.actor.fetchId()) });
                    return true;
                };
                Awareness.npcThreateningActor = () => boss;
                Safety.canEngageBotClanRaid = () => true;
                Safety.isProtectedRaidEntity = () => true;
                Revival.partyCombatInProgress = () => false;
                sessions.forEach(member => {
                    member.actor.state.setCasts(false); member.actor.state.setHits(false);
                    member.actor.setHp(member.actor.fetchMaxHp()); member.actor.setMp(member.actor.fetchMaxMp());
                });
                helper.actor.setHp(helper.actor.fetchMaxHp() * .1);
                for (const inCombat of [true, false]) {
                    Awareness.npcThreateningActor = () => inCombat ? boss : null;
                    sessions[0].backgroundHuntTarget = null;
                    sessions[0].raidPreparationComplete = helper.raidPreparationComplete = true;
                    for (const caster of [sessions[1], helper]) Hot.tick(caster, caster.actor, invoke('GameServer/Actor/Generics'), {});
                }
                assert.equal(targets.length, 4, 'hot support is checked during combat and between pulls');
                for (const context of targets) {
                    const expected = context.caster === base + 9 ? [base + 9] : ids.slice(0,9);
                    assert(Roster.exact(context.members, expected), 'native support selection cannot borrow recipients from the other party');
                    assert(expected.includes(context.owner), 'support owner belongs to the caster party');
                }
                Profiles.findById = id => id === spot.id ? { ...spot, center: { locX: 0, locY: 0, locZ: 0 } } : saved.profile.call(Profiles, id);
                Spots.containsLocation = (_spot, loc) => Math.abs(loc.locX) <= 1200;
                Town.townAt = actor => actor === helper.actor ? 'Giran' : null;
                helper.actor.setLocX(5000);
                const trips = [], coreAttacks = [];
                Travel.start = (session, _actor, target) => { trips.push([session.actor.fetchId(), target.id]); return true; };
                Tactics.support = () => false;
                Awareness.npcThreateningActor = member => member === helper ? null : boss;
                Safety.botClanRaidCombatPlan = () => ({ boss, minions: [], focusMinion: null });
                Hot.tick(helper, helper.actor, invoke('GameServer/Actor/Generics'), {});
                assert.deepEqual(trips, [[base + 9, spot.id]], 'a town-respawned helper uses the existing trip back to the raid source');
                Hot.tick(sessions[3], sessions[3].actor, invoke('GameServer/Actor/Generics'), {
                    executeCombat: session => coreAttacks.push(session.actor.fetchId()) });
                assert.deepEqual(coreAttacks, [base + 3], 'the main party keeps attacking while its helper returns from town');
                helper.backgroundPartyReturn = { partyId: party.partyId, spotId: spot.id };
                helper.spotRelocation = { spotId: spot.id };
                Revival.partyCombatInProgress = () => true;
                assert.equal(Travel.partyReturnInCombat(helper), false, 'siblings fighting do not cancel a helper return teleport');
                Awareness.npcThreateningActor = () => boss;
                assert.equal(Travel.partyReturnInCombat(helper), true, 'a real attack on the returning helper still interrupts its trip');
            } finally {
                Tactics.support = saved.support; Awareness.npcThreateningActor = saved.incoming;
                Safety.canEngageBotClanRaid = saved.legal; Safety.isProtectedRaidEntity = saved.protected;
                Revival.partyCombatInProgress = saved.combat;
                Profiles.findById = saved.profile; Spots.containsLocation = saved.contains;
                Travel.start = saved.start; Town.townAt = saved.town; Safety.botClanRaidCombatPlan = saved.plan;
                helper.actor.setLocX(saved.helperX);
                delete helper.backgroundPartyReturn; delete helper.spotRelocation;
                helper.actor.setHp(helper.actor.fetchMaxHp());
            }
        }
        assert.deepEqual(party.stats.raidAdmission, heldProof);
        await freshParty('magic');
        const caster = sessions[5], attack = caster.actor.attack, timers = [];
        const skill = caster.actor.skillset.fetchSkill(1184);
        caster.actor.setMp(caster.actor.fetchMaxMp() * 0.95);
        attack.queueTimer = callback => { timers.push(callback); return null; };
        attack.prepareSkillDamage = () => 10;
        attack.remoteHit(caster, boss, skill); registry.delete(base + 8); timers.at(-1)();
        registry.set(base + 8, { actor: sessions[8].actor, session: sessions[8] });
        assert.equal(boss.fetchHp(), 1000, 'actual offensive magic landing also fences a lost ninth'); assert(!Roster.held(Parties.find(party.partyId)));
        // The first native magic damage kills: real Die/destructor and EXP
        // run after durable opening, before any async promotion/goal closure.
        const beforeExp = caster.actor.fetchExp();
        timers.length = 0; boss.setHp(5); caster.actor.state.setCasts(false);
        caster.actor.skillReuseUntil.delete(skill.fetchSelfId()); // Fixture advances past the native reuse before its next cast.
        caster.actor.setMp(caster.actor.fetchMaxMp() * 0.95);
        attack.remoteHit(caster, boss, skill);
        timers.at(-1)(); party = Parties.find(party.partyId);
        assert(caster.actor.fetchMp() < caster.actor.fetchMaxMp() * 0.95,
            'native magic can open from the 95% boundary while paying its own cost without any refill');
        assert(boss.state.fetchDead()); assert.equal(boss.fetchDestId(), undefined);
        assert.equal(loot, 1); assert.equal(experience, ids.length); await goalCompletion;
        assert(caster.actor.fetchExp() > beforeExp, 'actual native party EXP reaches the killer after durable opening');
        await invoke('GameServer/Persistence/CharacterWriteQueue').flushAll();
        assert(Roster.nativeHotStarted(party), 'earned opening survives destructor and completed owner goal');
        const earned = structuredClone(party.stats.raidAdmission);
        sessions[8].actor.setLevel(51); await phase('cold'); await phase('hot');
        assert.deepEqual(party.stats.raidAdmission, earned, 'phase handoff/restart retains original9 earned proof despite post-hit level/goal noise');
        assert(await Lifecycle.confirmMarkedRaidStart(party, [], Date.now()));
        assert.equal(loot, 1); assert.equal(experience, ids.length); assert.equal(earned.members.length, ids.length);
        const row = (await query('SELECT * FROM bot_background_parties WHERE partyId=?', [party.partyId]))[0];
        party = Parties.acceptRow(row); assert(Roster.nativeHotStarted(party));
        console.log('Native marked raid impact: melee/magic races, defensive autoaggro, busy/rollback, one-hit death/EXP/goal completion and bounded opening inputs passed');
    } finally {
        Index.bossByTemplateId = original.boss; Life.partySessionSnapshot = original.snapshot; Combat.capture = original.capture;
        Statements.prepare = original.prepare; World.removeNpc = original.remove; World.user = original.user;
        Formulas.calcHitChance = original.hitChance;
        invoke('GameServer/Actor/Generics').experienceReward = original.experience;
        boss.destructor(sessions[0]);
    }
}
function productionResolverCases(members) {
    const Resolver = require('../src/GameServer/Bot/Population/BackgroundPartyResolver');
    const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
    const Encounter = require('../src/GameServer/Bot/Population/ColdRaidEncounter');
    const at = Date.now(), currentOwner = owner();
    const run = (people, raidOwner = currentOwner, actualParty = party) => Resolver.resolve({
        party: actualParty, members: people, spot, targetNpcId: 9900137, timestamp: at, elapsedMs: 15000, raidOwner });
    const incomplete = run(members.slice(0, 8));
    assert.equal(incomplete.debug.reason, 'raid_roster_incomplete'); assert.equal(incomplete.debug.fights, 0);
    assert(!incomplete.partyPatch.stats.raidAdmission);
    const ownerGone = run(members, null);
    assert.equal(ownerGone.partyPatch.status, 'dissolved'); assert.equal(ownerGone.debug.reason, 'raid_roster_owner_changed');
    assert(ownerGone.memberResults.every(row => row.result.materialize.exp === 0 && row.result.materialize.items.length === 0));
    // An owner snapshot behind a member (its level read before its last commit) waits for
    // the next snapshot, which the step's own commit publishes; refused again on it, the
    // roster is judged as any assembly.
    const lagging = { ...currentOwner, members: currentOwner.members.map((row, index) => index ? row : [row[0], row[1], row[2], row[3] + 1, row[4]]) };
    const behind = run(members, lagging);
    assert.equal(behind.debug.reason, 'raid_roster_member_changed');
    assert.notEqual(behind.partyPatch.status, 'dissolved', 'a roster refused on a snapshot behind it does not break up');
    assert.equal(behind.partyPatch.stats.rosterRecheck, 'raid_roster_member_changed');
    const again = run(members, lagging, { ...party, stats: { ...party.stats, rosterRecheck: 'raid_roster_member_changed' } });
    assert.equal(again.partyPatch.stats.rosterRecheck, undefined, 'refused again on the next snapshot: no second wait');
    const resting = members.map(state => ({ ...state, activity: 'resting',
        vitals: { ...state.vitals, mp: 0 }, stats: { ...state.stats, restUntil: at - 1 } }));
    const restingParty = { ...party, stats: { ...party.stats, restUntil: at - 1,
        raidPreparation: { status: 'preparing', passes: 1, remainingBuffs: 31 } } };
    const recovered = run(resting, currentOwner, restingParty);
    assert.equal(recovered.debug.activity, 'resting',
        'the marked roster must apply its native MP recovery before checking readiness to hunt');
    assert(recovered.memberResults.every(row => row.result.patch.vitals.mp > 0));
    assert.equal(recovered.debug.fights, 0, 'recovery never opens combat');
    assert(!recovered.partyPatch.stats.raidAdmission, 'only actual combat earns the marked admission');
    assert.equal(run(resting.slice(0, 8), currentOwner, restingParty).debug.reason, 'raid_roster_incomplete');
    assert.equal(run(resting, null, restingParty).debug.reason, 'raid_roster_owner_changed');
    const previous = { prepare: Solo.prepareRaidParty, fight: Solo.resolvePartyFight };
    let attempts = 0;
    try {
        Solo.prepareRaidParty = (people,at) => ({ ...previous.prepare(people,at), casts: 0, needsRest: false, ready: true });
        Solo.resolvePartyFight = input => {
            attempts++;
            return { won: false, encounter: { hp: 500, mob: { selfId: 9900137, maxHp: 1000 } },
                members: input.members.map(state => ({ state, vitals: { ...state.vitals }, profile: Combat.profileFor(state, at),
                    skillUses: 0, heals: 0, musicUses: 0, potionsUsed: 0, cooldowns: {} })),
                debug: { actions: 1, mobSelfId: 9900137, remainingHp: 500 } };
        };
        const readyParty = { ...party, stats: { ...party.stats, raidPreparation: { status: 'ready' } } };
        const exhausted = members.map(state => ({ ...state, vitals: { ...state.vitals,
            mp: state.vitals.maxMp * 0.2 } }));
        const recovery = run(exhausted, currentOwner, readyParty);
        assert.equal(attempts, 0, 'finished buffs with ordinary-party mana cannot start a raid');
        assert.equal(recovery.debug.fights, 0);
        assert(recovery.memberResults.some(row => row.result.patch.activity === 'resting'));
        assert(!recovery.partyPatch.stats.raidAdmission, 'paid recovery does not earn the first attack');
        assert(recovery.memberResults.every(row => row.result.patch.vitals.mp >= row.state.vitals.mp),
            'the native rest path actually regenerates mana instead of polling admission');
        const opened = run(members, currentOwner, readyParty);
        assert.equal(attempts, 1, 'production marked resolver reaches exactly one native fight leaf');
        assert.equal(opened.partyPatch.stats.raidAdmission.startedAt, at);
        assert.equal(opened.partyPatch.stats.raidAdmission.members.length, ids.length);
        assert.equal(opened.partyPatch.stats.raidEncounter.participants[party.partyId], at);
        assert.equal(opened.memberResults.length, ids.length);
    } finally { Solo.prepareRaidParty = previous.prepare; Solo.resolvePartyFight = previous.fight; Encounter.resetForTests(); }
}
let proposals = 0;
async function propose(proof, { reward = 100, status = 'active' } = {}) {
    const members = await refreshed();
    const [raid] = await query('SELECT revision FROM bot_raid_encounters WHERE raidKey=?', ['raid:9900137']);
    const revision = Number(raid?.revision || 0);
    const atomicGroup = { id: `full:${++proposals}`, memberIds: ids,
        partyChanges: [{ partyId: party.partyId, memberIds: ids, expectedPartyRevision: party.revision,
            updatedAt: Math.max(Date.now(), party.updatedAt + 1), status, nextResolveAt: Date.now() + 30000,
            statsJson: JSON.stringify({ ...party.stats, raidAdmission: proof }) }],
        raidCommit: { key: 'raid:9900137', expectedRevision: revision, revision: revision + 1,
            snapshot: { key: 'raid:9900137', raidInstanceId: marker.raidInstanceId, status: 'active', hp: 500,
                participants: { [party.partyId]: proof.startedAt }, updatedAt: Date.now() } } };
    const entries = members.map(member => ({ nextState: { ...member, exp: member.exp + reward },
        revision: member.simulation.revision, atomicGroup,
        proposal: InventorySummary.bagChange(member.inventory, member.inventory), options: { allowParty: true, allowLifecycle: true } }));
    return { entries };
}
async function reject(proof, mutation, restore, detail) {
    const prepared = await propose(proof);
    const before = await query('SELECT characterId,exp FROM bot_life_state ORDER BY characterId');
    try {
        await mutation();
        const result = await Owner.commitBatch(prepared.entries);
        assert(result.every(row => !row.ok && row.detail === detail), JSON.stringify(result.map(row => [row.reason, row.detail])));
        assert.deepEqual(await query('SELECT characterId,exp FROM bot_life_state ORDER BY characterId'), before);
    } finally { await restore(); }
}
async function phase(to) {
    const states = await refreshed(), at = Date.now();
    const result = await Database.transitionBackgroundParty({ partyId: party.partyId, expectedStatus: party.status,
        expectedPartyRevision: party.revision, expectedPhase: states[0].phase, phase: to,
        nextResolveAt: to === 'hot' ? null : at + 30000, statsJson: JSON.stringify(party.stats),
        members: states.map(state => ({ characterId: state.characterId, expectedRevision: state.simulation.revision,
            expectedUpdatedAt: state.updatedAt, patch: Owner.persistencePatch({ ...state, phase: to }, at) })) });
    assert(result.ok, result.reason); result.rows.forEach(row => Life.acceptLifecycleRow(row)); party = Parties.acceptRow(result.party);
}
async function main() {
    Database.init();
    try {
        assert(await Life.init()); await Parties.init();
        Catalog.findById = id => id === spot.id ? spot : old.find(id);
        Scope.projectSource = value => value?.id === spot.id ? { ...spot } : old.project(value);
        invoke('GameServer/Bot/AI/SpotService').containsLocation = (source, loc) => source?.id === spot.id ? Math.abs(loc.locX) < 1000 : old.contains(source, loc);
        const clan = await Database.createAutonomousClan({ name: 'FullNative', leaderId: base, memberIds: ids, founderQuorum: 5, maxBotMemberShare: 1 });
        assert(clan.ok);
        marker = { clanId: clan.clanId, ownerSection: 'productionGoal', goalKey: 'full-sword', generation: 'full-generation',
            memberIds: ids, sourceId: spot.id, npcId: spot.raidBossTemplateId, raidInstanceId: spot.raidInstanceId, ...(helperMode ? { coreMemberIds: ids.slice(0,9) } : {}), minPartySize: ids.length, maxPartySize: ids.length };
        goal = { goalKey: marker.goalKey, status: 'preparing', assignedMemberIds: ids, fullRoster: marker };
        assert((await Database.updateAutonomousClanGoal({ clanId: marker.clanId, ownerSection: marker.ownerSection, goal })).ok);
        const objective = { status: 'open', priority: 'required', reason: 'clan_equipment', clanOperation: 'equipment',
            clanId: marker.clanId, clanGoalKey: marker.goalKey, objectiveKey: 'direct_drop:full:10137', sourceKind: 'raid', raidBoss: true,
            spotId: spot.id, npcId: spot.raidBossTemplateId, sourceLevel: 50, minPartySize: ids.length, maxPartySize: ids.length, fullRoster: marker };
        let members = await refreshed();
        const ungrouped = members.map(member => ({ ...member, activity: 'party_wait', stats: { ...member.stats, clanPartyObjective: objective, partyRequest: objective } }));
        const roster = rows => Roster.selectMembers(rows, objective, Requests.limitsForObjective(objective)).length;
        assert.equal(roster(ungrouped), ids.length);
        assert.equal(roster(ungrouped.slice(0, 8)), 0);
        const twoBuffers = structuredClone(ungrouped);
        twoBuffers[1].stats.coldCombat.skills.push(...Combat.skillSnapshotsFromRecords([{ selfId: 1015, level: 1 }]));
        twoBuffers[2].classId = twoBuffers[2].stats.classId = twoBuffers[2].stats.coldCombat.classId = 17;
        twoBuffers[2].stats.coldCombat.skills.push(...Combat.skillSnapshotsFromRecords([{ selfId: 1068, level: 1 }]));
        assert.equal(roster(twoBuffers), ids.length, 'native two healing buffers accepted without generic healer formula');
        assert.equal(Requests.limitsForObjective(objective).minSize, ids.length);
        assert.deepEqual(Requests.partyObjectiveForPlan({ status: 'active', strategy: 'direct_drop', next: { spotId: spot.id, npcId: 10137 },
            clanGoal: { clanId: marker.clanId, goalKey: marker.goalKey, partyNeed: 'required', fullRoster: marker } }).fullRoster, marker);
        const prepared = Parties.prepareCommit({ partyId: 'full-native', leaderId: base, memberIds: ids, spotId: spot.id,
            status: 'active', startedAt: Date.now(), nextResolveAt: Date.now() + 30000, stats: { objective } });
        const assigned = ungrouped.map(member => Life.preparePartyAssignment(member, prepared.row.partyId, Gear.roleFor(member), base, Date.now() + 30000));
        const formed = await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
        assert(formed.ok);
        Life.acceptPartyAssignments(assigned, formed.lifeRows); party = Parties.acceptRow(formed.partyRow); members = await refreshed();
        const checked = admission(members); assert(checked.ok, checked.ok ? '' : JSON.stringify({checked,
            fit:require('../src/GameServer/Clan/ClanRaidPolicy').assessment({ members },spot,
                {assignedMemberIds:ids},{desiredMembers:9, coreMemberIds:marker.coreMemberIds, preferredMemberIds:ids})})); const proof = checked.proof;
        assert.equal(Roster.admission(party, members, spot, { owner: { ...owner(), raidBlocked: true }, arrived: true }).reason,
            'raid_failure_blocked', 'a ready nine cannot open a boss blocked by its clan failure memory');
        assert(Buffer.byteLength(JSON.stringify(proof)) <= 1024);
        for (const count of [7, 8]) assert(!admission(members.slice(0, count)).ok);
        assert(!admission([...members.slice(0, 8), members[0]]).ok);
        const changed = (index, patch) => members.map((member, i) => i === index ? { ...member, ...patch } : member);
        assert(!admission(changed(2, { classId: 21 })).ok);
        assert(!admission(changed(8, { clanId: 0 })).ok, 'foreign or lagging hot clan identity cannot open');
        assert(!admission(changed(2, { level: 59 })).ok);
        assert(!admission(changed(0, { inventory: {} })).ok);
        assert(!admission(changed(2, { stats: { ...members[2].stats, coldCombat: { ...members[2].stats.coldCombat, skills: [] } } })).ok);
        assert(!admission(changed(8, { stats: { ...members[8].stats, travel: { arrivalAt: Date.now() + 50000 } } })).ok);
        assert.equal(Roster.admission({ ...party, stats: {} }, members.slice(0, 7), spot).legacy, true);
        productionResolverCases(members);
        assert(!admission(changed(8, { stats: { ...members[8].stats, playerPartyTakeover: { playerId: 123 } } })).ok,
            'player-controlled guest cannot open the marked bot raid');
        const operation = await query(`INSERT INTO clan_operations(clanId,operationKey,operationType,leaderId,memberIdsJson)
            VALUES(?,'full-reserve','pob',?,'[]')`, [marker.clanId, base]);
        await query('INSERT INTO clan_operation_members(operationId,clanId,characterId) VALUES(?,?,?)', [operation.insertId, marker.clanId, base]);
        assert(!admission(members).ok, 'own active native operation reservation blocks opening');
        await query("UPDATE clan_operation_members SET status='released' WHERE characterId=?", [base]);
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.craftStationId',99) WHERE characterId=?", [base + 8]);
        assert(!admission(members).ok, 'native static-service projection cannot count as ordinary ninth');
        await query("UPDATE bot_life_state SET statsJson=json_remove(statsJson,'$.craftStationId') WHERE characterId=?", [base + 8]);
        const worker = new Runtime.ClanPlanningCoordinator();
        try { await worker.withJob(Date.now() + 30000, Data, async jobKey => {
            const result = await worker.prepareRaids({ jobKey, deadlineAt: Date.now() + 30000,
                clan: { id: marker.clanId, level: 0, physicalMemberCount: ids.length, state: { mode: 'autonomous' }, members: Roster.assessmentMembers(members) },
                spots: [spot], prospects: [], previousGoal: { assignedMemberIds: ids }, coreMemberIds: marker.coreMemberIds }, Data, [spot]);
            assert(result.teams[spot.id]?.actualReady); assert(Roster.exact(result.teams[spot.id].memberIds, ids));
        }); } finally { await worker.shutdown(); }
        const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
        const EncounterWire = require('../src/GameServer/Bot/Population/ColdRaidEncounter');
        const at = Date.now(), messages = [], currentOwner = owner();
        const kernel = new ColdSimulationKernel({ now: () => at, emit: (type, data) => messages.push({ type, data }),
            resolveSolo: () => ({}), projectResolve: member => member,
            resolveParty: input => {
                assert.deepEqual(input.raidOwner, currentOwner, 'actual kernel forwards the compact current owner context');
                const checked = Roster.admission(input.party, input.members, input.spot, { owner: input.raidOwner, arrived: true, timestamp: at });
                assert(checked.ok, checked.reason);
                const snapshot = EncounterWire.record(input.party, EncounterWire.begin(input.party, input.spot, 10137, at), { won: false,
                    encounter: { hp: 500, mob: { maxHp: 1000 } } }, at);
                return { partyPatch: { stats: { raidEncounter: snapshot, raidAdmission: checked.proof } }, nextResolveAt: at + 30000,
                    memberResults: input.members.map(state => ({ state, result: { events: [] } })), events: [] };
            } });
        try {
            for (const member of members) { kernel.upsert({ state: member });
                kernel.inFlight.set(member.characterId, { state: member, startedAt: at, partyId: party.partyId }); }
            // The run carries the raid owner its parties table row published.
            kernel.partyRuns.set(party.partyId, { party, members, spot, startedAt: at, raidOwner: currentOwner });
            await kernel.resolvePartyStep(party.partyId);
            const proposals = messages.filter(message => message.type === 'proposal_batch').flatMap(message => message.data.proposals);
            assert.equal(proposals.length, ids.length);
            assert(proposals.every(proposal => JSON.parse(proposal.atomicGroup.partyChanges[0].statsJson).raidAdmission.members.length === ids.length));
            kernel.onCommitAck({ results: proposals.map(proposal => ({ characterId: proposal.characterId, raidStepId: proposal.raidStepId,
                ok: false, proposalId: proposal.proposalId })) });
        } finally { await kernel.shutdown(); EncounterWire.resetForTests(); }
        await reject(proof, () => query('UPDATE characters SET classId=21 WHERE id=?', [base + 2]),
            () => query('UPDATE characters SET classId=15 WHERE id=?', [base + 2]), 'raid_roster_member_changed');
        await reject(proof, () => query('UPDATE characters SET clanId=0 WHERE id=?', [base + 8]),
            () => query('UPDATE characters SET clanId=? WHERE id=?', [marker.clanId, base + 8]), 'raid_roster_member_changed');
        await reject(proof, () => Database.updateAutonomousClanGoal({ clanId: marker.clanId, ownerSection: marker.ownerSection,
            goal: { ...goal, fullRoster: { ...marker, generation: 'replacement' } } }),
        () => Database.updateAutonomousClanGoal({ clanId: marker.clanId, ownerSection: marker.ownerSection, goal }), 'raid_roster_owner_changed');
        await reject(proof, async () => { spot.raidInstanceId = 'respawn'; }, async () => { spot.raidInstanceId = marker.raidInstanceId; }, 'raid_roster_source_changed');
        await reject(proof, async () => {
            await query("UPDATE clan_simulation_clans SET stateJson=json_set(stateJson,'$.raidFailures',json(?)) WHERE clanId=?",
                [JSON.stringify({ [marker.npcId]: { bossTemplateId: marker.npcId, retryAllowed: false, failedAt: 100 } }), marker.clanId]);
        }, async () => {
            await query("UPDATE clan_simulation_clans SET stateJson=json_remove(stateJson,'$.raidFailures') WHERE clanId=?", [marker.clanId]);
        }, 'raid_failure_blocked');
        const stale = await propose(proof);
        const noReward = await query('SELECT characterId,exp FROM bot_life_state ORDER BY characterId');
        stale.entries[0].revision -= 1;
        assert((await Owner.commitBatch(stale.entries)).every(row => !row.ok && row.detail === 'stale_revision'));
        assert.deepEqual(await query('SELECT characterId,exp FROM bot_life_state ORDER BY characterId'), noReward);
        // No prior native opening provenance: a held-looking proof alone is rejected.
        const forged = await propose(proof); delete forged.entries[0].atomicGroup.raidCommit.snapshot.participants;
        assert((await Owner.commitBatch(forged.entries)).every(row => !row.ok && row.detail === 'raid_roster_not_opened'));
        const success = await propose(proof); const result = await Owner.commitBatch(success.entries);
        assert(result.every(row => row.ok), JSON.stringify(result.map(row => [row.reason, row.detail])));
        party = Parties.acceptRow(result[0].raidPartyRow); assert(Roster.held(party, spot));
        assert.equal(await Parties.createOrUpdate({ ...party, stats: { ...party.stats, raidAdmission: null } }), null,
            'generic party save cannot erase earned admission proof');
        const lostMarker = await propose(proof);
        const nextStats = JSON.parse(lostMarker.entries[0].atomicGroup.partyChanges[0].statsJson);
        delete nextStats.objective.fullRoster;
        lostMarker.entries[0].atomicGroup.partyChanges[0].statsJson = JSON.stringify(nextStats);
        assert((await Owner.commitBatch(lostMarker.entries)).every(row => !row.ok && row.detail === 'raid_roster_held_changed'),
            'held atomic update cannot erase marker and reopen as legacy7');
        assert((await Owner.commitBatch(success.entries)).every(row => !row.ok), 'native replay fences suppress another result');
        const persisted = (await query('SELECT * FROM bot_background_parties WHERE partyId=?', [party.partyId]))[0];
        party = Parties.acceptRow(persisted); assert(Roster.held(party, spot), 'restart reconstruction preserves original9 proof');
        await Database.updateAutonomousClanGoal({ clanId: marker.clanId, ownerSection: 'goal', goal: { status: 'completed', goalKey: 'unrelated-cash' } });
        await query('UPDATE bot_life_state SET adena=adena+10,sp=sp+10 WHERE characterId=?', [base]);
        members = await refreshed(); const casualty = changed(8, { vitals: { ...members[8].vitals, hp: 0 } });
        assert(Roster.admission(party, casualty, spot, { owner: null, arrived: false }).held);
        assert.equal(party.stats.raidAdmission.members.length, ids.length);
        await phase('hot'); await phase('cold'); assert.deepEqual(party.stats.raidAdmission, proof, 'native phase handoff retains earned proof');
        // A merely admitted hot group cannot become started through autoaggro
        // or use a missing ninth after the asynchronous admission reply.
        await phase('hot');
        const states = await refreshed(), sessions = nativeSessions(states);
        const registry = new Map(sessions.map(session => [session.actor.fetchId(), { actor: session.actor, session }]));
        World.registeredActorById = id => registry.get(Number(id));
        Life.partySessionSnapshot = (session, current) => ({ ...current, phase: 'hot', level: session.actor.fetchLevel(),
            inventory: Life.inventorySummaryFromItems(session.actor.backpack.fetchItems()),
            stats: { ...current.stats, classId: session.actor.fetchClassId(), coldCombat: Combat.capture(session.actor), hennas: session.hennas || [] } });
        const admittedParty = { ...party, stats: { ...party.stats, raidAdmission: { ...proof, startedAt: null } } };
        let targetId = base, instance = marker.raidInstanceId;
        Index.bossByTemplateId = () => ({ raidInstanceId: instance, fetchId: () => 998877, fetchSelfId: () => spot.raidBossTemplateId, fetchDestId: () => targetId });
        assert(!Roster.nativeHotStarted(admittedParty), 'autoaggro while admission pending is not opening provenance');
        registry.delete(base + 8);
        assert.equal(Hot.roster(sessions[0]).length, ids.length - 1);
        assert(!Lifecycle.markedAttackReady(admittedParty, sessions), 'logout ninth AFTER async approval prevents first physical strike');
        assert(!Roster.nativeHotStarted(admittedParty));
        registry.set(base + 8, { actor: sessions[8].actor, session: sessions[8] });
        sessions[0].raidOpenedBossId = 998877;
        assert(!Roster.nativeHotStarted(admittedParty), 'autoaggro tactical flag without an actual offensive impact never opens');
        targetId = 123456; assert(!Roster.nativeHotStarted(admittedParty), 'unrelated party engagement cannot promote');
        targetId = base; instance = 'another-instance'; assert(!Roster.nativeHotStarted(admittedParty));
        // Exercise the actual hot opening RPC and native lifecycle writer.
        instance = marker.raidInstanceId;
        await phase('cold');
        assert(await Parties.createOrUpdate({ ...party, status: 'dissolved', nextResolveAt: null }));
        await Life.releaseDissolvedPartyMembers(party.partyId, 'raid_defeated');
        members = await refreshed();
        const hotPrepared = Parties.prepareCommit({ partyId: 'full-hot-native', leaderId: base, memberIds: ids, spotId: spot.id,
            status: 'active', startedAt: Date.now(), nextResolveAt: Date.now() + 30000, stats: { objective } });
        const hotAssigned = members.map(member => Life.preparePartyAssignment({ ...member,
            stats: { ...member.stats, clanPartyObjective: objective, partyRequest: objective } }, hotPrepared.row.partyId, Gear.roleFor(member), base, Date.now() + 30000));
        const hotFormed = await Database.commitBackgroundPartyMembership({ party: hotPrepared.row, members: hotAssigned });
        assert(hotFormed.ok);
        Life.acceptPartyAssignments(hotAssigned, hotFormed.lifeRows); party = Parties.acceptRow(hotFormed.partyRow); await phase('hot');
        sessions.forEach(session => { session.hotBackgroundPartyId = party.partyId; delete session.raidOpenedBossId; });
        Runtime.start();
        const openingRows = await query('SELECT * FROM bot_background_parties WHERE partyId=?', [party.partyId]);
        const manaBeforeOpening = sessions.map(session => session.actor.fetchMp());
        sessions.forEach(session => session.actor.setMp(session.actor.fetchMaxMp() * 0.2));
        const deniedOpening = await Lifecycle.openMarkedRaid(party, sessions);
        assert.equal(deniedOpening.ok, false, 'a visible nine at 20% MP cannot open the raid');
        assert.equal(deniedOpening.reason, 'raid_resources_not_ready');
        assert.deepEqual(await query('SELECT * FROM bot_background_parties WHERE partyId=?', [party.partyId]), openingRows,
            'denied admission does not write an opening proof');
        sessions.forEach((session, index) => {
            assert.equal(session.actor.fetchMp(), session.actor.fetchMaxMp() * 0.2, 'admission grants no free recovery');
            session.actor.setMp(manaBeforeOpening[index]);
        });
        const opened = await Lifecycle.openMarkedRaid(party, sessions);
        assert(opened.ok, opened.reason); party = opened.party;
        assert(Roster.admitted(party)); assert(!Roster.held(party));
        registry.delete(base + 8); assert(!Lifecycle.markedAttackReady(party, sessions));
        assert(!Roster.nativeHotStarted(party));
        registry.set(base + 8, { actor: sessions[8].actor, session: sessions[8] });
        // Admission before any hit also survives phase transfer without
        // manufacturing an active encounter or earned fight.
        await phase('cold'); assert(!Roster.held(party));
        await nativeImpactCases(sessions, registry);
        console.log('Full clan raid roster: native formation/worker, exact9 admission, held casualties/recovery/handoff and hot first-strike race passed');
    } finally {
        Catalog.findById = old.find; Scope.projectSource = old.project; invoke('GameServer/Bot/AI/SpotService').containsLocation = old.contains;
        World.registeredActorById = old.registered; Index.bossByTemplateId = old.boss; Life.partySessionSnapshot = old.snapshot;
        await Runtime.shutdown(); await Database.close(); fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
