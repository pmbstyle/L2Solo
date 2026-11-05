'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('combat-skill-authority');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const SavedStats = require('../src/GameServer/Bot/SavedStats');
const Native = require('./helpers/nativeMarketFixture');
const ids = [719980, 719981, 719982];
const partyIds = ids.slice(0, 2);
const clone = value => JSON.parse(JSON.stringify(value));
const rank = state => state.stats.coldCombat.skills.find(skill => skill.selfId === 1097)?.level || 0;

async function resources() {
    return {
        characters: await Database.execute(['SELECT id,level,exp,sp FROM characters ORDER BY id']),
        items: await Database.execute(['SELECT * FROM items ORDER BY id']),
        skills: await Database.execute(['SELECT * FROM skills ORDER BY characterId,selfId'])
    };
}

async function verify(id, dynamic) {
    const state = Life.cachedState(id);
    const row = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0];
    const expected = [...Profile.skillSnapshotsFromRecords(await Database.fetchSkills(id))].sort((a, b) => a.selfId - b.selfId);
    // The row saves the learned ranks of a kit made of their records; read
    // back, the kit is those records again.
    assert.deepEqual(JSON.parse(row.statsJson).coldCombat.skills, expected.map(skill => [skill.selfId, skill.level]));
    const stored = SavedStats.body(row.statsJson).coldCombat;
    assert.deepEqual(stored.skills, expected);
    assert.deepEqual(state.stats.coldCombat, stored, 'cache receives the actual persisted profile');
    assert.equal(stored.skillSource, 'database');
    assert.equal(stored.version, Profile.PROFILE_VERSION);
    for (const [key, value] of Object.entries(dynamic)) assert.deepEqual(stored[key], value, `${key} still follows the accepted resolve`);
}

async function main() {
    try {
        Database.init(); fixture.assertConfigured(options.default);
        for (const id of ids) {
            await Native.character(Database, id, `SkillAuthority${id}`, `bot_skill_authority_${id}`);
            await Database.updateCharacterClassId(id, 51);
            await Database.updateCharacterExperience(id, 52, Number(Data.experience[51]) + 1, 1337);
            for (let book = 0; book < 2; book++) await Database.setItem(id, { selfId: 1049, name: 'Spellbook: Ice Bolt', amount: 1 });
            await Database.setSkill({ selfId: 1097, name: 'Dreaming Spirit', level: 9, passive: false }, id);
        }
        // A previously current profile can already lag behind its learned rows.
        await Database.updateSkillLevel(ids[1], 1097, 10);
        const oldKit = Profile.legacySnapshot({ stats: { classId: 51 } }, [{ selfId: 1097, level: 9 }]);
        oldKit.version = Profile.PROFILE_VERSION - 1;
        oldKit.effects = [{ id: 1068, level: 1, expiresAt: Date.now() + 600000 }];
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,level,sp,phase,activity,statsJson,inventorySummary)
            VALUES(?,?,'ExistingProfile',52,1337,'cold','resting',?,'{}')`,
            [ids[1], `bot_skill_authority_${ids[1]}`, JSON.stringify({ classId: 51, hennas: [null,null,null], coldCombat: oldKit })]]);
        await Life.init();
        assert.equal(rank(Life.cachedState(ids[1])), 10, 'startup repairs the old profile version before publication');
        assert.deepEqual(Life.cachedState(ids[1]).stats.coldCombat.effects, oldKit.effects);
        console.log('PASS startup restores learned ranks without removing active effects');

        const stale = new Map();
        for (const id of ids) {
            const state = { characterId: id, accountName: `bot_skill_authority_${id}`, name: `SkillAuthority${id}`,
                level: 52, exp: Number(Data.experience[51]) + 1, sp: 1337, adena: 0, phase: 'cold', activity: 'resting',
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                timing: { lastResolvedAt: Date.now(), nextResolveAt: Date.now() + 60000 },
                stats: { classId: 51, classProgressionClassId: 51, classProgressionLevel: 52, coldCombat: clone(oldKit) } };
            assert(await Life.upsertState(state, 'skill_authority_seed'));
            stale.set(id, clone(oldKit));
            const trained = await Life.reviewTrainingAfterCommit(Life.cachedState(id));
            assert.equal(rank(trained), 10); assert.equal(trained.sp, 1337);
        }
        const before = await resources();
        await Parties.init();
        const prepared = Parties.prepareCommit({ partyId: 'skill-authority-party', leaderId: ids[0], memberIds: partyIds,
            status: 'active', startedAt: Date.now(), nextResolveAt: Date.now() + 60000, stats: {} });
        const assigned = partyIds.map(id => Life.preparePartyAssignment(Life.cachedState(id), prepared.row.partyId, 'buffer', ids[0], Date.now() + 60000));
        for (const entry of assigned) {
            entry.snapshot.stats = { ...entry.snapshot.stats, coldCombat: clone(oldKit) };
            const stats = JSON.parse(entry.row.statsJson);
            entry.row.statsJson = JSON.stringify({ ...stats, coldCombat: clone(oldKit) });
        }
        const membership = await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
        assert(membership.ok);
        Life.acceptPartyAssignments(assigned, membership.lifeRows); Parties.acceptRow(membership.partyRow);
        for (const id of partyIds) { await verify(id, { effects: oldKit.effects }); assert.equal(rank(Life.cachedState(id)), 10); }
        console.log('PASS party membership commits and cache publication use native skill ranks');
        const dynamic = { effects: [{ id: 1040, level: 2, expiresAt: Date.now() + 300000 }], cooldowns: { 1097: Date.now() + 12000 },
            charges: 2, chargeExpiresAt: Date.now() + 5000, summon: { active: true, skillId: 1225, expiresAt: Date.now() + 20000 } };
        const results = await Owner.commitBatch(partyIds.map(id => {
            const state = Life.cachedState(id);
            // The kit of the row it stepped from, with the step's combat state: a
            // skills writer moves the revision, so an older kit is refused, not rebuilt.
            const kit = { ...clone(state.stats.coldCombat), ...dynamic };
            return { revision: state.simulation.revision, nextState: { ...state, updatedAt: Date.now() + 1, stats: { ...state.stats, coldCombat: kit } },
                options: { allowParty: true, allowLifecycle: true }, atomicGroup: { id: 'skill-authority-commit', memberIds: partyIds } };
        }));
        assert(results.every(result => result.ok));
        for (const id of partyIds) { await verify(id, dynamic); assert.equal(rank(Life.cachedState(id)), 10); }
        assert.deepEqual(await resources(), before, 'repairing a profile cannot grant skills or spend SP/items');
        console.log('PASS actual atomic party batch writes the stepped kit with its combat state');

        const id = ids[2];
        const state = Life.cachedState(id);
        const cleared = { effects: [], cooldowns: {}, charges: 0, chargeExpiresAt: null, summon: null };
        const [committed] = await Owner.commitBatch([{ revision: state.simulation.revision, nextState: { ...state, stats: { ...state.stats,
            coldCombat: { ...clone(state.stats.coldCombat), ...cleared } } }, options: { allowParty: true, allowLifecycle: true } }]);
        assert(committed.ok);
        await verify(id, cleared); assert.equal(rank(Life.cachedState(id)), 10);
        console.log('PASS ordinary commit keeps ranks and genuine effect/cooldown/summon removals');

        // A kit with a record that is not its rank's data, or of a rank the
        // data does not have, stays whole in the row, and reads back as committed.
        const odd = Life.cachedState(id);
        const oddKit = { ...clone(odd.stats.coldCombat), skills: clone(odd.stats.coldCombat.skills) };
        oddKit.skills.unshift({ ...oddKit.skills[0], selfId: 999999 });
        oddKit.skills.at(-1).power += 1;
        const [oddCommit] = await Owner.commitBatch([{ revision: odd.simulation.revision, nextState: { ...odd,
            stats: { ...odd.stats, coldCombat: oddKit } }, options: { allowParty: true, allowLifecycle: true } }]);
        assert(oddCommit.ok);
        const oddRow = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0];
        assert.deepEqual(JSON.parse(oddRow.statsJson).coldCombat.skills, oddKit.skills);
        assert.deepEqual(SavedStats.body(oddRow.statsJson).coldCombat, oddKit);
        const [restored] = await Owner.commitBatch([{ revision: Life.cachedState(id).simulation.revision, nextState: { ...odd,
            stats: { ...odd.stats, coldCombat: { ...oddKit, skills: odd.stats.coldCombat.skills } } },
        options: { allowParty: true, allowLifecycle: true } }]);
        assert(restored.ok);
        await verify(id, cleared);
        console.log('PASS a kit that is not its ranks\' data (or names a rank the data lacks) is saved whole and read back as committed');

        const current = Life.cachedState(id);
        assert(await Life.upsertState({ ...current, stats: { ...current.stats, coldCombat: { ...stale.get(id), ...dynamic } } }, 'stale_actor_profile'));
        await verify(id, dynamic); assert.equal(rank(Life.cachedState(id)), 10);
        assert.deepEqual(await resources(), before);
        const withoutProfile = { ...Life.cachedState(id).stats };
        delete withoutProfile.coldCombat;
        assert(await Life.upsertState({ ...Life.cachedState(id), stats: withoutProfile }, 'omitted_actor_profile'));
        await verify(id, dynamic); assert.equal(rank(Life.cachedState(id)), 10);
        console.log('PASS generic lifecycle saves preserve learned skills and publish the canonical row');

        // Actual native removals and historical ranks remain authoritative,
        // rather than a monotonic union of old snapshots or a current-level tree.
        await Database.deleteSkills(id);
        assert(await Life.upsertState({ ...Life.cachedState(id), stats: { ...Life.cachedState(id).stats, coldCombat: stale.get(id) } }, 'native_skill_removal'));
        await verify(id, {}); assert.equal(rank(Life.cachedState(id)), 0);
        await Database.setSkill({ selfId: 1097, name: 'Dreaming Spirit', level: 10, passive: false }, id);
        assert(await Life.upsertState({ ...Life.cachedState(id), level: 40 }, 'delevel_retains_native_skill'));
        await verify(id, {}); assert.equal(rank(Life.cachedState(id)), 10);
        console.log('PASS native deletions and retained ranks after delevel follow the skill table');
    } finally {
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
