const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-simulation-slice1.sqlite');
const Database = invoke('Database');
const Policy = invoke('GameServer/Clan/ClanSimulationPolicy');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');
const ClanRules = invoke('GameServer/Clan/ClanRules');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_slice1', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_slice1', ?, ?, 0, 20, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, ?, ?, 20, 'hunting', 'cold', '{}', ?, ?)`);
    for (let index = 1; index <= 10; index += 1) {
        const id = 4100000 + index;
        const classId = index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : index === 4 ? 11 : index === 5 ? 54 : 1;
        const name = `SliceOne${index}`;
        insertCharacter.run(id, name, classId);
        insertState.run(id, 'bot_pop_slice1', name, JSON.stringify({
            generatedCold: true,
            generatedIndex: index,
            classId,
            partyHistory: index === 1 ? { 4100002: { runs: 2, lastGroupedAt: 1 } } : {}
        }), index);
    }
    seed.close();
}

function founderCandidate() {
    return {
        characterId: 1,
        classId: 4,
        level: 20,
        clanId: 0,
        persona: { traits: {
            ambition: 0.9,
            assertiveness: 0.8,
            resilience: 0.8,
            sociability: 0.7,
            commitment: 0.6
        } },
        partyHistory: { 2: { runs: 2 } }
    };
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();

    try {
        assert.strictEqual(Policy.hasFirstProfession({ classId: 0 }), false);
        assert.strictEqual(Policy.hasFirstProfession({ classId: 4 }), true);
        const eligibility = Policy.founderEligibility(founderCandidate(), { quorumCandidates: [1, 2, 3, 4, 5] });
        assert.strictEqual(eligibility.ok, true, `founder should pass: ${eligibility.reasons.join(',')}`);
        assert.strictEqual(Policy.founderEligibility({
            ...founderCandidate(),
            persona: { traits: { ...founderCandidate().persona.traits, ambition: 0.2 } }
        }, { quorumCandidates: [1, 2, 3, 4, 5] }).ok, false);
        assert.strictEqual(Policy.isStaticService({ stats: { craftStationId: 1 } }), true);

        const existing = Policy.selectExistingClan({
            ...founderCandidate(),
            characterId: 2,
            classId: 15,
            persona: { traits: { commitment: 0.8 } },
            partyHistory: { 4100001: { runs: 3 } }
        }, [{
            id: 1,
            level: 0,
            members: [{ id: 4100001, classId: 4 }]
        }], { threshold: 0.55 });
        assert(existing, 'a missing healer role with party history should match an existing clan');
        assert.strictEqual(existing.suitability.role, 'healer');

        const completeRoster = [4, 15, 21, 11, 54, 3, 57]
            .map((classId, index) => ({ id: 4200100 + index, classId }));
        const growthCandidate = {
            ...founderCandidate(),
            characterId: 4200200,
            classId: 3,
            persona: { traits: { commitment: 0.8 } },
            partyHistory: { 4100001: { runs: 4 } }
        };
        const growthMatch = Policy.selectExistingClan(growthCandidate, [{
            id: 2,
            level: 2,
            members: completeRoster
        }]);
        assert(growthMatch, 'a strong duplicate-role candidate should grow an under-target clan');
        assert.strictEqual(growthMatch.suitability.roleNeed, false);
        assert.strictEqual(growthMatch.suitability.growthNeed, true);
        assert.strictEqual(growthMatch.suitability.targetMemberCount, 14);

        const targetRoster = [...completeRoster, ...Array.from({ length: 7 }, (_, index) => ({
            id: 4200110 + index,
            classId: 3
        }))];
        assert.strictEqual(Policy.selectExistingClan(growthCandidate, [{
            id: 2,
            level: 2,
            members: targetRoster
        }]), null, 'a clan at its growth target should not accept arbitrary duplicate roles');

        const projection = await ClanSimulationService.candidateProjection(20);
        assert.strictEqual(projection.length, 10, 'founder projection should only contain generated adventurers');
        assert.strictEqual(projection.some((candidate) => candidate.stats.generatedCold === true), true);

        const projectedFounder = projection.find((candidate) => candidate.characterId === 4100001);
        const created = await ClanSimulationService.resolveCandidate({
            ...projectedFounder,
            persona: { traits: {
                ambition: 0.9,
                assertiveness: 0.8,
                resilience: 0.8,
                sociability: 0.7,
                commitment: 0.6
            } },
            partyHistory: { 4100002: { runs: 2 } }
        }, { clans: [], pool: projection, name: 'SliceOneClan' });
        assert.strictEqual(created.ok, true);
        assert.strictEqual(created.botMembers, 5);
        const [state] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const initialMemberIds = JSON.parse(state.stateJson).memberIds;
        assert.strictEqual(initialMemberIds.length, 5);
        assert(initialMemberIds.includes(4100001));
        const freeIds = [4100001, 4100002, 4100003, 4100004, 4100005, 4100006, 4100007, 4100008, 4100009, 4100010]
            .filter((id) => !initialMemberIds.includes(id));

        const joined = await Database.joinAutonomousClan({
            clanId: created.clanId,
            characterId: freeIds[0],
            memberLimit: ClanRules.memberLimit(0),
            maxBotMemberShare: 0.70
        });
        assert.strictEqual(joined.ok, true);
        const joinedAgain = await Database.joinAutonomousClan({
            clanId: created.clanId,
            characterId: freeIds[1],
            memberLimit: ClanRules.memberLimit(0),
            maxBotMemberShare: 0.70
        });
        assert.strictEqual(joinedAgain.ok, true);
        const blockedJoin = await Database.joinAutonomousClan({
            clanId: created.clanId,
            characterId: freeIds[2],
            memberLimit: ClanRules.memberLimit(0),
            maxBotMemberShare: 0.70
        });
        assert.strictEqual(blockedJoin.ok, false);
        assert.strictEqual(blockedJoin.code, 'join_population_limit');

        const [updatedState] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        assert.deepStrictEqual(JSON.parse(updatedState.stateJson).memberIds, [...initialMemberIds, freeIds[0], freeIds[1]].sort((a, b) => a - b));
        assert.strictEqual(await Database.isAutonomousBotMember(freeIds[0], created.clanId), true);
        assert.strictEqual(await Database.isAutonomousBotMember(freeIds[2], created.clanId), false);

        await ClanService.reload();
        const actor = {
            fetchId: () => freeIds[0],
            fetchClanId: () => created.clanId,
            fetchClanCreateExpiryTime: () => 0,
            setClanId() {},
            setClanPrivileges() {},
            setClanJoinExpiryTime() {}
        };
        const removal = await ClanService.removeMember(actor, { force: true });
        assert.strictEqual(removal.ok, false);
        assert.strictEqual(removal.code, 'autonomous_membership_permanent');

        await Database.execute(['UPDATE characters SET clanId = 0, clanPrivileges = 0', []]);
        await Database.execute(['DELETE FROM clan_simulation_clans', []]);
        await Database.execute(['DELETE FROM clans', []]);
        const [raceA, raceB] = await Promise.all([
            Database.createAutonomousClan({
                name: 'RaceAlpha', leaderId: 4100001,
                memberIds: [4100001, 4100002, 4100003, 4100004, 4100005],
                founderQuorum: 5, maxBotClans: 1, maxBotMemberShare: 1.00
            }),
            Database.createAutonomousClan({
                name: 'RaceBravo', leaderId: 4100006,
                memberIds: [4100006, 4100007, 4100008, 4100009, 4100010],
                founderQuorum: 5, maxBotClans: 1, maxBotMemberShare: 1.00
            })
        ]);
        assert.strictEqual([raceA, raceB].filter((result) => result.ok).length, 1,
            'concurrent founding must reserve at most one clan under a one-clan limit');
        assert.strictEqual([raceA, raceB].filter((result) => result.code === 'founder_clan_limit').length, 1);
        const [autonomousCount] = await Database.execute(['SELECT COUNT(*) AS count FROM clan_simulation_clans', []]);
        assert.strictEqual(Number(autonomousCount.count), 1);

        console.log('Clan simulation Slice 1 checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
