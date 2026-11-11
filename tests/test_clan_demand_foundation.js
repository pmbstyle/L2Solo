'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const directory = fs.mkdtempSync(path.join(__dirname, '../tmp/clan-demand-foundation-'));
const world = path.join(directory, 'world.sqlite');
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${world}\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Events = invoke('GameServer/Clan/ClanReviewEvents');
const Raid = invoke('GameServer/Clan/ClanRaidPolicy');
const Capabilities = invoke('GameServer/Clan/ClanCandidateCapabilities');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const SavedSkills = require('../src/GameServer/Bot/SavedSkills');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const seed = new DatabaseSync(world);
seed.exec(fs.readFileSync(path.join(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
seed.exec("INSERT INTO accounts(username,password) VALUES('bot_pop_demand','fixture')");
const base = 820000;
const insertCharacter = seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
    VALUES(?,'bot_pop_demand',?,?,0,50,500,300,0,0,0,0,0,0,0)`);
const insertLife = seed.prepare(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,spotId,
    hp,maxHp,mp,maxMp,inventorySummary,statsJson,updatedAt) VALUES(?,'bot_pop_demand',?,50,'cold','hunting','fixture',500,500,300,300,'{}',?,?)`);
for (let i = 0; i < 240; i++) {
    const classId = i < 150 ? 0 : 15;
    const stats = { generatedCold: true, classId, classProgressionClassId: classId, classProgressionLevel: 50,
        coldCombat: { version: Combat.PROFILE_VERSION, skillSource: 'database', classId, skills: [] } };
    if (i === 239) stats.coldCombat.skills = Combat.skillSnapshotsFromRecords([{ selfId: 1015, level: 1 }]);
    insertCharacter.run(base + i, `Demand${i}`, classId);
    if (i === 239) seed.prepare('INSERT INTO skills(selfId,name,passive,level,characterId) VALUES(1015,\'Heal\',0,1,?)').run(base + i);
    insertLife.run(base + i, `Demand${i}`, JSON.stringify(stats), 1000 + i);
}
seed.close();
const query = (sql, params = []) => Database.execute([sql, params]);
const projection = async id => (await query('SELECT classId,level,clanId,joinAvailability FROM bot_party_candidate_projection WHERE characterId=?', [id]))[0];
const events = async () => (await Events.drain()).map(row => row.clanId);
const demand = { ownerSection: 'goal', goalKey: 'fixture', generation: 'one', classIds: [15, 17], minLevel: 45, maxLevel: 55 };

async function main() {
    Database.init();
    try {
        assert(await Life.init());
        const legacy = await Life.clanOperationCandidates({ targetClanId: 820500, limit: 128, minLevel: 45, targetLevel: 50 });
        assert.equal(legacy.length, 128, 'old public query retains its limit/default ordering');
        assert.equal(legacy[0].characterId, base);
        assert.deepEqual(await Life.clanOperationCandidates({ classIds: [] }), [], 'empty class need must never broaden to every role');
        const first = await Life.clanOperationCandidates({ classIds: [15], minLevel: 45, maxLevel: 55, unclanned: true, limit: 128 });
        assert.equal(first.length, 64);
        assert.equal(first[0].characterId, base + 150, '150 wrong roles before healer cannot starve native role filter');
        assert(first.every(member => !Capabilities.contextualCapability(member, 'healer')), 'class is only a shortlist');
        const cursor = first.at(-1).candidateCursor;
        const next = await Life.clanOperationCandidates({ classIds: [15], minLevel: 45, maxLevel: 55, unclanned: true, cursor });
        assert.equal(next.length, 26);
        assert(next.every(member => member.characterId > cursor.characterId));
        assert(Capabilities.contextualCapability(next.at(-1), 'healer'), 'next page reaches learned healer rejected by first skill window');
        await query('UPDATE bot_life_state SET updatedAt=updatedAt+10000 WHERE characterId>=?', [base + 150]);
        assert.deepEqual((await Life.clanOperationCandidates({ classIds: [15], minLevel: 45, maxLevel: 55, cursor })).map(member => member.characterId),
            next.map(member => member.characterId), 'unrelated timestamp changes never move continuation');
        assert.equal((await Life.statesByIds(Array.from({ length: 240 }, (_, i) => base + i))).length, 64);
        assert(!Object.hasOwn(Life.cachedState(base), 'simulationOwner'), 'E272: cached worker snapshot source has no flat owner');
        assert(require('../src/GameServer/Bot/Population/ColdSimulationProtocol').commandCheckpoint(Life.cachedState(base)),
            'E272: cached state stays commandable by the cold worker');
        const metadataTrigger = (await query("SELECT sql FROM sqlite_master WHERE name='bot_party_candidate_metadata'"))[0].sql;
        assert(!/json_extract|statsJson/i.test(metadataTrigger), 'new lease/phase/party metadata trigger reads only cheap scalars');
        const savedSkillsTrigger = (await query("SELECT sql FROM sqlite_temp_master WHERE name='clan_candidate_saved_skills'"))[0].sql;
        assert(!savedSkillsTrigger.includes('json_each'), 'saved skills trigger has no correlated per-skill SQL scans');
        assert(savedSkillsTrigger.indexOf('clan_candidate_watched') < savedSkillsTrigger.indexOf('json_extract'),
            'an addressed watch guard precedes skill JSON extraction');
        const identity = base + 164;
        await query("UPDATE bot_life_state SET accountName='bot_craft_demand' WHERE characterId=?", [identity]);
        assert.equal((await projection(identity)).joinAvailability, 0, 'static account change invalidates ordinary identity');
        await query("UPDATE bot_life_state SET accountName='bot_pop_demand' WHERE characterId=?", [identity]);
        assert.equal((await projection(identity)).joinAvailability, 1);
        await query("INSERT INTO accounts(username,password) VALUES('demand_personal','fixture')");
        await query("UPDATE characters SET username='demand_personal' WHERE id=?", [identity]);
        await query("UPDATE bot_life_state SET accountName='demand_personal',statsJson=json_set(statsJson,'$.generatedCold',0) WHERE characterId=?", [identity]);
        assert.equal((await projection(identity)).joinAvailability, 0, 'generated identity is recomputed from its JSON source');
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.generatedCold',1) WHERE characterId=?", [identity]);
        assert.equal((await projection(identity)).joinAvailability, 1);
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.craftShop',json('{}')) WHERE characterId=?", [identity]);
        assert.equal((await projection(identity)).joinAvailability, 0);
        await query("UPDATE bot_life_state SET statsJson=json_remove(statsJson,'$.craftShop') WHERE characterId=?", [identity]);
        assert.equal((await projection(identity)).joinAvailability, 1);
        await query("UPDATE characters SET username='bot_pop_demand' WHERE id=?", [identity]);
        await query("UPDATE bot_life_state SET accountName='bot_pop_demand' WHERE characterId=?", [identity]);
        const clauses = ["phase='hot'", "statsJson=json_set(statsJson,'$.craftShop',json('{}'))", "partyId='foreign-party'", "activity='crafting'", 'spotId=NULL',
            "statsJson=json_set(statsJson,'$.craftStationId',1)", "statsJson=json_set(statsJson,'$.playerPartyTakeover',1)"];
        for (let i = 0; i < clauses.length; i++) await query(`UPDATE bot_life_state SET ${clauses[i]} WHERE characterId=?`, [base + 150 + i]);
        await query("INSERT INTO accounts(username,password) VALUES('bot_craft_demand','fixture')");
        await query("UPDATE characters SET username='bot_craft_demand' WHERE id=?", [base + 157]);
        // Native account identity is checked independently from generatedCold.
        const excluded = await Life.clanOperationCandidates({ classIds: [15], minLevel: 45, maxLevel: 55 });
        assert(excluded.every(member => member.characterId >= base + 158));
        await query('INSERT INTO clans(id,name,leaderId) VALUES(?,?,?)', [820500, 'DemandClan', base]);
        await query("INSERT INTO clan_operations(id,clanId,operationKey,operationType,leaderId) VALUES(820600,820500,'fixture','raid',?)", [base]);
        await query('INSERT INTO clan_operation_members(operationId,clanId,characterId) VALUES(820600,820500,?)', [base + 158]);
        assert(!(await Life.clanOperationCandidates({ classIds: [15], minLevel: 45, maxLevel: 55 })).some(member => member.characterId === base + 158));
        await Database.updateCharacterClan(base + 159, 820500, 0, 0, 0);
        assert.equal((await projection(base + 159)).clanId, 820500);
        assert(!(await Life.clanOperationCandidates({ classIds: [15] })).some(member => member.characterId === base + 159));
        // Use the actual SQL of the public path to prove both family and band
        // are applied by the native index before LIMIT, rather than JSON role.
        const execute = Database.execute; let captured;
        Database.execute = function(statement, operation) {
            if (operation === 'bot-life:clan-recruitment-candidates') captured = statement;
            return execute.call(this, statement, operation);
        };
        try { await Life.clanOperationCandidates({ classIds: [15], minLevel: 45, maxLevel: 55 }); }
        finally { Database.execute = execute; }
        const plan = await query(`EXPLAIN QUERY PLAN ${captured[0]}`, captured[1]);
        assert(plan.some(row => row.detail.includes('bot_party_candidate_recruitment') && row.detail.includes('classId=?') && row.detail.includes('level>')),
            JSON.stringify(plan));
        Events.stop();
        const originalParse = JSON.parse;
        let capabilityParses = 0;
        JSON.parse = function(raw, ...args) {
            if (typeof raw === 'string' && raw.startsWith('[[')) capabilityParses++;
            return originalParse.call(this, raw, ...args);
        };
        try {
            await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.coldCombat.skills',json(?)) WHERE characterId=?",
                [JSON.stringify(Combat.skillSnapshotsFromRecords([{ selfId: 1015, level: 1 }])), base + 165]);
        } finally { JSON.parse = originalParse; }
        assert.equal(capabilityParses, 0, 'no recruitment watches means no JS skill JSON parse');
        assert(Events.watchRecruitment(820500, demand));
        assert(Events.watchRecruitment(820501, { ...demand, classIds: [4] }));
        const skillSourceId = base + 166;
        const learnedHeal = Combat.skillSnapshotsFromRecords([{ selfId: 1015, level: 1 }]);
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.coldCombat.skills',json(?),'$.coldCombat.skillSource','unresolved') WHERE characterId=?",
            [JSON.stringify(learnedHeal), skillSourceId]);
        assert.deepEqual(await events(), [], 'unresolved saved array is not an owned learned capability');
        await query('BEGIN IMMEDIATE');
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.coldCombat.skillSource','database') WHERE characterId=?", [skillSourceId]);
        assert.deepEqual(await events(), [], 'skill-source change cannot notify before actual commit');
        await query('ROLLBACK');
        assert.deepEqual(await events(), [], 'rolled back skill-source change leaves no event');
        await query('BEGIN IMMEDIATE');
        capabilityParses = 0;
        JSON.parse = function(raw, ...args) {
            if (typeof raw === 'string' && raw.startsWith('[[')) capabilityParses++;
            return originalParse.call(this, raw, ...args);
        };
        try {
            await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.coldCombat.skillSource','database') WHERE characterId=?", [skillSourceId]);
        } finally { JSON.parse = originalParse; }
        assert.equal(capabilityParses, 2, 'saved capability comparison parses each compact array once');
        await query('COMMIT');
        assert.deepEqual(await events(), [820500], 'same learned array becomes real capability when its native source becomes database');
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.coldCombat.skillSource','hot') WHERE characterId=?", [skillSourceId]);
        assert.deepEqual(await events(), [], 'database to hot with the same learned skills changes no capability');
        const savedRanks = SavedSkills.pack(learnedHeal);
        assert.deepEqual(savedRanks, [[1015, 1]]);
        await query("UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.coldCombat.skills',json(?)) WHERE characterId=?",
            [JSON.stringify(savedRanks), skillSourceId]);
        assert.deepEqual(await events(), [], 'the same learned skills saved as their ranks change no capability');
        await query('UPDATE bot_life_state SET sp=sp+1 WHERE characterId=?', [skillSourceId]);
        assert.deepEqual(await events(), []);
        await query('BEGIN IMMEDIATE');
        await query('UPDATE characters SET classId=17 WHERE id=?', [base + 160]);
        assert.deepEqual(await events(), [], 'raw accepted SQL has no event before the enclosing transaction commits');
        await query('ROLLBACK');
        assert.deepEqual(await events(), [], 'raw transaction rollback discards pending notifications');
        await Database.updateCharacterClassId(base + 160, 17);
        assert.deepEqual(await projection(base + 160), { classId: 17, level: 50, clanId: 0, joinAvailability: 1 });
        assert.equal((await Life.statesByIds([base + 160]))[0].stats.classId, 17, 'hydrated class agrees with index while saved stats still say15');
        assert.deepEqual(await events(), [820500]);
        await Database.updateCharacterClassId(base + 160, 17);
        assert.deepEqual(await events(), [], 'class replay is silent');
        await Database.updateCharacterExperience(base + 160, 50, 100, 1000);
        await query('UPDATE bot_life_state SET sp=sp+1 WHERE characterId=?', [base + 160]);
        assert.deepEqual(await events(), [], 'SP-only change cannot start recruitment');
        await query('UPDATE bot_life_state SET level=56 WHERE characterId=?', [base + 160]);
        assert.deepEqual(await events(), [820500], 'leaving a relevant level band wakes its prior watch');
        await query('UPDATE bot_life_state SET level=57 WHERE characterId=?', [base + 160]);
        assert.deepEqual(await events(), [], 'outside-band changes wake no clan');
        await query('UPDATE bot_life_state SET level=50 WHERE characterId=?', [base + 160]); await events();
        const promotion = base + 161;
        const route = require('../data/Templates/second_profession_trials.json').find(row => row.classId === 17);
        for (const mark of route.marks) await query('INSERT INTO items(selfId,name,amount,characterId) VALUES(?,?,1,?)', [mark, 'Mark', promotion]);
        await Database.completeSecondProfession(promotion, 15, 17);
        assert.equal((await projection(promotion)).classId, 17);
        assert.equal((await Life.statesByIds([promotion]))[0].classId, 17);
        assert.deepEqual(await events(), [820500]);
        await assert.rejects(Database.completeSecondProfession(promotion, 15, 17));
        assert.deepEqual(await events(), [], 'rejected promotion is silent');
        const coldId = base + 162;
        const current = (await query('SELECT simulationRevision FROM bot_life_state WHERE characterId=?', [coldId]))[0];
        const unchangedProjection = (await query('SELECT payloadJson,ordinaryEligible FROM bot_party_candidate_projection WHERE characterId=?', [coldId]))[0];
        const timestamp = Date.now();
        const request = { characterId: coldId, expectedRevision: current.simulationRevision,
            timestamp: timestamp + 1, allowLifecycle: true, patch: { phase: 'cold', level: 51 }, physical: { classId: 17, level: 51, maxHp: 500, maxMp: 300 } };
        await assert.rejects(Database.commitAndReleaseColdSimulationLeases([{ ...request,
            physical: { ...request.physical, pvpKills: Array(19).fill({ victimId: 1 }) } }]), /too many kills/);
        assert.deepEqual(await events(), [], 'rolled back native cold row/class changes publish no pending capability event');
        assert.equal((await projection(coldId)).classId, 15);
        assert.equal((await projection(coldId)).joinAvailability, 1, 'a far bot is never loaned away from the clan view');
        assert((await Database.commitAndReleaseColdSimulationLeases([request]))[0].ok);
        assert.deepEqual((await query('SELECT payloadJson,ordinaryEligible FROM bot_party_candidate_projection WHERE characterId=?', [coldId]))[0],
            unchangedProjection, 'a native cold commit reuses identity without changing the legacy payload');
        assert.deepEqual(await events(), [820500], 'a successful commit publishes the class change as one addressed review');
        assert(!(await Database.commitAndReleaseColdSimulationLeases([request]))[0].ok);
        assert.deepEqual(await events(), [], 'rejected cold replay cannot publish a wave');
        await Database.setSkill({ selfId: 1015, level: 1, name: 'Heal', passive: false }, coldId);
        assert.deepEqual(await events(), [820500]);
        await Database.setSkill({ selfId: 1015, level: 1, name: 'Heal', passive: false }, coldId);
        assert.deepEqual(await events(), [], 'unchanged learned rank is silent');
        await Database.setSkill({ selfId: 3, level: 1, name: 'Power Strike', passive: false }, base);
        assert.deepEqual(await events(), [], 'wrong family does not wake watched healer');
        await Database.updateCharacterClassId(base + 163, 0);
        assert.equal((await Life.statesByIds([base + 163]))[0].classId, 0, 'real class0 wins over stale stats15'); await events();
        Events.track({ id: 820500, state: { mode: 'autonomous', goal: { goalKey: 'fixture' }, recruitmentDemand: demand } });
        assert.equal(Events.recruitmentCount(), 2);
        Events.track({ id: 820500, state: { mode: 'autonomous', goal: { goalKey: 'replacement' }, recruitmentDemand: demand } });
        assert.equal(Events.recruitmentCount(), 1, 'replacement removes prior request watch');
        Events.track({ id: 820501, state: { mode: 'player_managed', recruitmentDemand: demand } });
        assert.equal(Events.recruitmentCount(), 0);
        for (let i = 0; i < 41; i++) assert.equal(Events.watchRecruitment(900000 + i, demand), i < 40);
        assert.equal(Events.recruitmentCount(), 40);
        Events.untrack(900000); assert.equal(Events.recruitmentCount(), 39);
        Events.stop(); assert.equal(Events.recruitmentCount(), 0);
        pureCapabilities();
        console.log('Clan demand foundation: native projection, canonical professions, bounded role pages, commit/rollback/replay events and capability tests passed');
    } finally { Events.stop(); await Database.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

function pureCapabilities() {
    const readiness = Gear.combatReadiness;
    const Estimate=require('../src/GameServer/Clan/ClanRaidEstimate');
    const Priority=require('../src/GameServer/Bot/Population/RaidRosterPriority');
    const estimate=Estimate.estimate, facts=Priority.facts;
    Estimate.estimate=()=>({assessment:{ready:true,reason:'raid_ready'},estimate:{}});
    Priority.facts=member=>({score:member.level});
    Gear.combatReadiness = () => ({ hasWeapon: true, armorCount: 5, armorRank: 2, weaponRank: 2, effectiveLevel: 54 });
    const member = (id, classId, skills = []) => ({ characterId: id, classId, level: 50, phase: 'cold',
        stats: { classId, coldCombat: { skillSource: 'database', skills: Combat.skillSnapshotsFromRecords(skills) } } });
    const heal = [{ selfId: 1015, level: 1 }], buff = [{ selfId: 1068, level: 1 }];
    try {
        const sparse = [member(1, 4), member(2, 15), member(3, 17), member(4, 21), member(5, 34), member(6, 9), member(7, 10)];
        assert(Raid.assessment({ members: sparse }, { avgLevel: 50 }).ready, 'legacy sparse seven keeps native default');
        const strict = Raid.assessment({ members: sparse }, { avgLevel: 50 }, null, { desiredMembers: 9 });
        assert(!strict.ready); assert.equal(strict.deficits.members, 2);
        assert.equal(strict.deficits.mainBuffers, 1); assert.equal(strict.deficits.healing.healers, 1);
        const core = sparse.map(entry => entry.characterId === 2 ? member(2, 15, heal) : entry.characterId === 3 ? member(3, 17, buff) : entry);
        const optionalOverlord = member(26, 51, Combat.skillRecordsFromTree(51, 50));
        const ownedPreference = Raid.assessment({ members: [...core, member(24, 0), member(25, 9), optionalOverlord] },
            { avgLevel: 50 }, null, { desiredMembers: 9, preferredMemberIds: core.map(entry => entry.characterId) });
        assert(ownedPreference.ready && !ownedPreference.eligible.includes(optionalOverlord));
        assert.equal(ownedPreference.eligible.filter(entry => !core.includes(entry)).length, 2,
            'strict native capability roster keeps owned Prophet and needs exactly two joins');
        const full = [...core, member(8, 55), member(9, 57)];
        const before = JSON.stringify(full);
        const assessed = Raid.assessment({ members: full }, { avgLevel: 50 }, null, { desiredMembers: 9 });
        assert(assessed.ready); assert.equal(assessed.core.length, 9); assert.equal(assessed.eligible.length, 9);
        assert.equal(assessed.requirements.members, 9); assert.equal(assessed.deficits.members, 0);
        assert.equal(JSON.stringify(full), before, 'hypothetical assessment changes no members or reservations');
        const onlySix = [...core.slice(0, 6), member(8, 55), member(9, 57), member(10, 57)];
        assert(Raid.assessment({ members: onlySix }, { avgLevel: 50 }, null, { desiredMembers: 9 }).ready,
            'equipped dwarves contribute native damage like other DDs');
        const healingBuffers = [...full.filter(entry => entry.characterId !== 2 && entry.characterId !== 3),
            member(10, 51, Combat.skillRecordsFromTree(51, 50)), member(11, 52, Combat.skillRecordsFromTree(52, 50))];
        assert(Raid.assessment({ members: healingBuffers }, { avgLevel: 50 }, null, { desiredMembers: 9 }).ready, 'native two healing buffers replace one healer');
        assert.equal(Raid.raidRole(member(12, 7)), 'damage'); assert.equal(Raid.raidRole(member(13, 9)), 'damage');
        assert.equal(Raid.raidRole(member(14, 10)), 'damage'); assert.equal(Raid.raidRole(member(15, 21)), 'damage');
        assert(!Capabilities.contextualCapability(member(15, 21, buff), 'mainBuffer'), 'music occupies damage rather than main buff');
        const dwarf = { ...member(20, 57), level: 30, stats: { dwarvenCraftLevel: 2, coldCombat: { skillSource: 'database', skills: [] } } };
        assert(Capabilities.contextualCapability(dwarf, 'craft', { recipe: { level: 2 } }));
        assert(!Capabilities.contextualCapability(dwarf, 'craft', { recipe: { level: 3 } }));
        const reward = { spoils: [{ overall: 100, items: [{ selfId: 1872, chance: 100, min: 1, max: 1 }] }] };
        assert(!Capabilities.contextualCapability(dwarf, 'spoil', { reward, itemId: 1872 }), 'under40 dwarf tag is no proof');
        const spoiler = member(21, 55, [{ selfId: 254, level: 1 }]);
        assert(!Capabilities.contextualCapability(spoiler, 'spoil', { reward, itemId: 1872 }), 'Sweep42 is required in new demand');
        spoiler.stats.coldCombat.skills = Combat.skillSnapshotsFromRecords([{ selfId: 254, level: 1 }, { selfId: 42, level: 1 }]);
        assert(Capabilities.contextualCapability(spoiler, 'spoil', { reward, itemId: 1872 }));
        assert(!Capabilities.contextualCapability(spoiler, 'spoil', { reward, itemId: 1873 }), 'no useful target spoil means no economic demand');
        const healerClasses = Capabilities.classIdsForRequirements(['healer']);
        assert(healerClasses.includes(15) && !healerClasses.includes(21));
        assert(!Capabilities.classIdsForRequirements(['mainBuffer']).includes(21));
    } finally { Gear.combatReadiness = readiness; Estimate.estimate=estimate; Priority.facts=facts; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
