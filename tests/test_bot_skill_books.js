'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(require('node:os').tmpdir(), `l2solo-skill-gate-${require('node:crypto').randomUUID()}`);
fs.mkdirSync(directory);
const config = path.join(directory, 'fixture.ini'), source = fs.readFileSync(path.resolve('config/default.ini'), 'utf8');
const sections = source.indexOf('[AuthServer]'); assert(sections > 0);
fs.writeFileSync(config, `[Database]\npath = ${path.join(directory,'world.sqlite')}\nhistoryPath = ${path.join(directory,'history.sqlite')}\n\n${source.slice(sections)}`);
process.env.L2NODE_CONFIG_FILE = config; delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
const Skillset = invoke('GameServer/Actor/Skillset');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');

async function main() {
    try {
        assert.equal(options.default.Database.path,path.join(directory,'world.sqlite'));
        assert.equal(options.default.Database.historyPath,path.join(directory,'history.sqlite'));
        assert(path.isAbsolute(options.default.Database.path) && path.isAbsolute(options.default.Database.historyPath));
        console.log('Isolated native skill paths:',options.default.Database.path,options.default.Database.historyPath);
        Data.init(); Database.init(); assert(Database.isReady());
        assert.equal(Catalog.nextTraining(16, 45, 1011).bookId, null, 'Heal no longer requires an attack book');
        assert.equal(Catalog.nextTraining(16, 45, 1027).bookId, null, 'Group Heal no longer requires an attack book');
        const supportId = async (account, classId) => {
            await Database.createAccount(account, 'fixture');
            const result = await Database.createCharacter(account, { name: account.slice(4), race: 0,
                classId, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
                locX: 0, locY: 0, locZ: 0 });
            await Database.updateCharacterExperience(result.insertId, 45, Number(Data.experience[44]) + 1, 1e8);
            return Number(result.insertId);
        };
        const bishop = await supportId('bot_bishop_books', 16);
        for (const skillId of [1011, 1027]) {
            const training = Catalog.nextTraining(16, 45, skillId);
            const learned = await Database.learnBotSkill(bishop, skillId, training.level);
            assert(learned.learned, 'support skills are free without a spellbook');
            assert.deepEqual(learned.consumedBooks, []);
        }
        const bishopState = { level: 45, clanLevel: 1, inventory: {}, stats: { clanId: 1, classId: 16, coldCombat: { skills: [] } } };
        for (const book of Catalog.missingBooks(bishopState)) {
            assert(Profile.isAttackSkill(Profile.skillSnapshotsFromRecords([{ selfId: book.skillId, level: 1 }])[0]));
        }
        const seeded = await supportId('bot_seeded_books', 16);
        await invoke('GameServer/Bot/BotClassProgression').reconcile({ characterId: seeded, classId: 16, level: 45 });
        const seededSkills = await Database.fetchSkills(seeded);
        assert(seededSkills.some(row => row.selfId === 1011), 'a Bishop automatically receives Heal');
        assert(seededSkills.some(row => row.selfId === 1027), 'a Bishop automatically receives Group Heal');
        const songs = await supportId('bot_singer_books', 21);
        await new Skillset().awardSkills(songs, 21, 45, { botTraining: true });
        assert((await Database.fetchSkills(songs)).some(row => row.selfId === 267), 'Song of Warding is learned without its book');
        const sorcerer = await supportId('bot_sorcerer_books', 12);
        const clanId = Number((await Database.createClan({ name: 'TrainingFixture', leaderId: sorcerer })).insertId);
        await Database.updateClanLevel(clanId, 1);
        await invoke('GameServer/Clan/ClanSupplyPolicy').init();
        await Database.updateCharacterClan(sorcerer, clanId, 0, 0, 0);
        assert.deepEqual(await Database.learnBotSkill(sorcerer, 1184, 1),
            { learned: true, level: 1, spentSp: 0, consumedBooks: [] }, 'clan attack skills require no book');
        const supportInventory = { ...bishopState, inventory: { 1152: { selfId: 1152, amount: 2, kind: 'Other.Spellbook', rank: 'none', basePrice: 100 } } };
        assert.equal(Disposition.saleCandidates(supportInventory, { allowPreTradeCleanup: true }).find(row => row.selfId === 1152).count, 2,
            'unneeded support books may all be sold');
        await Database.createAccount('bot_pop_books', 'fixture');
        const id = Number((await Database.createCharacter('bot_pop_books', { name: 'BookLearner', race: 0,
            classId: 10, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
            locX: 0, locY: 0, locZ: 0 })).insertId);
        await Database.updateCharacterClan(id, clanId, 0, 0, 0);
        await Database.updateCharacterExperience(id, 14, Number(Data.experience[13]) + 1, 0);
        const first = Catalog.nextTraining(10, 14, 1184);
        assert.equal(Catalog.bookFor(1184), 1049);
        assert.equal(first.bookId, null); assert.equal(first.sp, 0);
        assert.equal((await Database.learnBotSkill(id, 1184, first.level + 1)).reason, 'ineligible_rank');
        const free = await Database.learnBotSkill(id, 1184, first.level);
        assert.deepEqual(free, { learned: true, level: first.level, spentSp: 0, consumedBooks: [] });
        await Database.setItem(id, { selfId: 1049, name: 'Spellbook: Ice Bolt', amount: 2 });
        const snapshot = async () => ({ character: await Database.fetchCharacters('bot_pop_books'),
            skills: await Database.fetchSkills(id), items: await Database.fetchItems(id) });
        const before = await snapshot();
        const second = Catalog.nextTraining(10, 14, 1184, first.level);
        let calls = 0;
        await assert.rejects(Database.learnBotSkill(id, 1184, second.level, { beforeWrite() {
            if (++calls === 2) throw Error('retired_before_skill_write');
        } }), /retired_before_skill_write/);
        assert.equal(calls, 2); assert.deepEqual(await snapshot(), before, 'retired grant changes no skills, SP or books');
        await Database.updateCharacterExperience(id, 14, Number(Data.experience[13]) + 1, 0);
        await new Skillset().awardSkills(id, 10, 14, { botTraining: true });
        assert.equal((await Database.fetchSkill(id, 1184))[0].level, 4, 'all eligible ranks are free with zero SP');
        assert.equal((await Database.fetchCharacters('bot_pop_books'))[0].sp, 0);
        assert.deepEqual(await Database.fetchItems(id), before.items, 'held books are never consumed');
        assert.equal((await Database.learnBotSkill(id, 1184, 1)).reason, 'already_known');
        assert.equal((await Database.learnBotSkill(id, 1184, 5)).reason, 'ineligible_rank', 'future ranks remain level gated');

        const empty = { characterId: id, level: 14, sp: 0, inventory: {}, stats: { classId: 10, clanId,
            coldCombat: { classId: 10, skillSource: 'database', skills: [] } } };
        assert.deepEqual(Catalog.requiredBooks(empty), []);
        assert.deepEqual(Catalog.missingBooks(empty), []);
        assert(Catalog.needsTraining(empty), 'missing skills reconcile with zero SP and no books');
        assert.equal(Profile.profileFor(empty).skills.length, 0, 'combat uses persisted grants, not imaginary tree ranks');
        const held = { ...empty, inventory: { 1049: { selfId: 1049, name: 'Spellbook: Ice Bolt', amount: 2,
            kind: 'Other.Spellbook', rank: 'none', basePrice: 100 } } };
        for (const state of [held, { ...held, stats: { ...held.stats, clanId: 0 } }]) {
            const sale = Disposition.saleCandidates(state, { allowPreTradeCleanup: true });
            assert.equal(sale.find(row => row.selfId === 1049).count, 2, 'no bot reserves a skill book');
            assert.equal(Disposition.isNpcOnlyItem(state.inventory[1049], undefined, state), true);
        }
        for (const [account, classId] of [
            ['bot_free_solo', 12], ['bot_free_bishop', 16], ['bot_free_singer', 21],
            ['bot_craft_free', 57], ['bot_free_transfer', 10]
        ]) {
            const botId = await supportId(account, classId);
            await Database.updateCharacterExperience(botId, 45, Number(Data.experience[44]) + 1, 0);
            const result = await invoke('GameServer/Bot/BotClassProgression').reconcile({ characterId: botId, classId, level: 45 });
            assert.equal(result.spentSp, 0); assert.deepEqual(result.consumedBooks, []);
            const skills = await Database.fetchSkills(botId);
            assert.equal(Catalog.needsTraining({ level: 45, sp: 0, stats: { classId: result.classId, coldCombat: { skills } } }),
                false, `${account} receives its complete eligible class tree`);
            assert.equal((await Database.fetchCharacters(account))[0].sp, 0);
            assert.deepEqual(await Database.fetchItems(botId), []);
            const repeated = await invoke('GameServer/Bot/BotClassProgression').reconcile({ characterId: botId, classId: result.classId, level: 45 });
            assert.equal(repeated.learnedCount, 0, 'reconciliation is idempotent');
        }
        const player = await supportId('player_skill_guard', 10);
        assert.equal((await Database.learnBotSkill(player, 1184, 1)).reason, 'not_bot');

        const treeSource = Data.skillTree;
        const realLearn = Database.learnBotSkill;
        try {
            const mage = treeSource.find((tree) => tree.classId === 10);
            Data.skillTree = [{ ...mage, skills: mage.skills.filter((skill) => skill.selfId === 1184) }];
            await Database.deleteSkills(id);
            await Database.updateCharacterExperience(id, 14, Number(Data.experience[13]) + 1, 100000);
            const session = { accountId: 'bot_pop_books', dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
            const Actor = invoke('GameServer/Actor/Actor');
            session.actor = new Actor(session, { ...utils.crushOb(Data.classTemplates.find((row) => row.classId === 10)),
                ...(await Database.fetchCharacters('bot_pop_books'))[0], items: await Database.fetchItems(id),
                paperdoll: utils.tupleAlloc(16, {}) });
            let earned = false;
            const Queue = invoke('GameServer/Persistence/CharacterWriteQueue');
            Database.learnBotSkill = async function(...args) {
                const result = await realLearn.apply(this, args);
                if (result.learned && !earned) {
                    earned = true;
                    session.actor.setSp(session.actor.fetchSp() + 500);
                    Queue.experience(id, 14, session.actor.fetchExp(), session.actor.fetchSp());
                }
                return result;
            };
            const Training = invoke('GameServer/Bot/BotSkillTraining');
            const work = Training.review(session);
            assert.equal(Training.review(session), work, 'concurrent events share the native training chain');
            const trained = await work;
            await Queue.flushCharacter(id);
            assert(trained.learnedCount > 1);
            assert.equal(trained.spentSp, 0); assert.deepEqual(trained.consumedBooks, []);
            assert.equal(session.actor.fetchSp(), 100500);
            assert.equal((await Database.fetchCharacters('bot_pop_books'))[0].sp, session.actor.fetchSp(),
                'SP earned during automatic grants survives in the actor and database');
            assert.deepEqual(await Database.fetchItems(id), before.items);
            assert.equal(session.actor.backpack.fetchItems()[0].fetchAmount(), 2);
            assert.equal(session.actor.skillset.fetchSkill(1184).fetchLevel(), (await Database.fetchSkill(id, 1184))[0].level);
        } finally { Data.skillTree = treeSource; Database.learnBotSkill = realLearn; }
        console.log('Free bot skills: zero SP, no books, full trees/professions, native guards, hot rewards and NPC cleanup passed');
    } finally {
        await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
