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
            assert(learned.learned, 'support training spends SP without a spellbook');
            assert.deepEqual(learned.consumedBooks, []);
        }
        const bishopState = { level: 45, inventory: {}, stats: { classId: 16, coldCombat: { skills: [] } } };
        for (const book of Catalog.missingBooks(bishopState)) {
            assert(Profile.isAttackSkill(Profile.skillSnapshotsFromRecords([{ selfId: book.skillId, level: 1 }])[0]));
        }
        const seeded = await supportId('bot_seeded_books', 16);
        // ARCH-NOTE: ensureBaseLoadout is private. Exercise its exact profile-training
        // entry point with ample SP; ordinary seeding may exhaust its level-based SP.
        await invoke('GameServer/Bot/BotClassProgression').reconcile({ characterId: seeded, classId: 16, level: 45 });
        const seededSkills = await Database.fetchSkills(seeded);
        assert(seededSkills.some(row => row.selfId === 1011), 'a Bishop seeded with enough SP learns Heal');
        assert(seededSkills.some(row => row.selfId === 1027), 'a Bishop seeded with enough SP learns Group Heal');
        const songs = await supportId('bot_singer_books', 21);
        await new Skillset().awardSkills(songs, 21, 45, { botTraining: true });
        assert((await Database.fetchSkills(songs)).some(row => row.selfId === 267), 'Song of Warding is learned without its book');
        const sorcerer = await supportId('bot_sorcerer_books', 12);
        assert.equal((await Database.learnBotSkill(sorcerer, 1184, 1)).reason, 'missing_book', 'attack training still needs Ice Bolt');
        const supportInventory = { ...bishopState, inventory: { 1152: { selfId: 1152, amount: 2, kind: 'Other.Spellbook', rank: 'none', basePrice: 100 } } };
        assert.equal(Disposition.saleCandidates(supportInventory, { allowPreTradeCleanup: true }).find(row => row.selfId === 1152).count, 2,
            'unneeded support books may all be sold');
        await Database.createAccount('bot_pop_books', 'fixture');
        const id = Number((await Database.createCharacter('bot_pop_books', { name: 'BookLearner', race: 0,
            classId: 10, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
            locX: 0, locY: 0, locZ: 0 })).insertId);
        await Database.updateCharacterExperience(id, 14, Number(Data.experience[13]) + 1, 10000);
        const first = Catalog.nextTraining(10, 14, 1184);
        assert.equal(first.bookId, 1049); assert.equal(first.sp, 240);
        assert.equal((await Database.learnBotSkill(id, 1184, first.level)).reason, 'missing_book');
        assert.equal((await Database.learnBotSkill(id, 1184, first.level + 1)).reason, 'ineligible_rank');
        await Database.setItem(id, { selfId: first.bookId, name: 'Spellbook: Ice Bolt', amount: 2 });
        const snapshot = async () => ({ character: await Database.fetchCharacters('bot_pop_books'),
            skills: await Database.fetchSkills(id), items: await Database.fetchItems(id) });
        const before = await snapshot();
        let calls = 0;
        await assert.rejects(Database.learnBotSkill(id, 1184, first.level, { beforeWrite() {
            if (++calls === 4) throw Error('retired_before_skill_write');
        } }), /retired_before_skill_write/);
        assert.equal(calls, 4); assert.deepEqual(await snapshot(), before, 'SP, book and rank roll back together');
        const paid = await Database.learnBotSkill(id, 1184, first.level);
        assert.equal(paid.learned, true); assert.equal(paid.spentSp, 240);
        assert.equal((await Database.fetchItems(id))[0].amount, 1);
        const second = Catalog.nextTraining(10, 14, 1184, first.level);
        assert.equal(second.bookId, null);
        const promoted = await Database.learnBotSkill(id, 1184, second.level);
        assert.equal(promoted.learned, true); assert.deepEqual(promoted.consumedBooks, []);
        assert.equal((await Database.fetchItems(id))[0].amount, 1, 'a rank upgrade never consumes another book');
        assert.equal((await Database.learnBotSkill(id, 1184, first.level)).reason, 'already_known');
        await Database.updateCharacterExperience(id, 14, Number(Data.experience[13]) + 1, 0);
        const next = Catalog.nextTraining(10, 14, 1184, second.level);
        assert.equal((await Database.learnBotSkill(id, 1184, next.level)).reason, 'insufficient_sp');

        const empty = { characterId: id, level: 14, sp: 1000, inventory: {}, stats: { classId: 10,
            coldCombat: { classId: 10, skillSource: 'database', skills: [] } } };
        assert.equal(Catalog.missingBooks(empty).find((book) => book.skillId === 1184).selfId, 1049);
        assert.equal(Profile.treeSnapshot(empty).skills.length, 0);
        assert.equal(Profile.profileFor(empty).skills.length, 0, 'empty DB kit cannot acquire free tree skills in combat');
        const held = { ...empty, inventory: { 1049: { selfId: 1049, name: 'Spellbook: Ice Bolt', amount: 2,
            kind: 'Other.Spellbook', rank: 'none', basePrice: 100 } } };
        assert(Catalog.needsTraining(held)); assert.equal(Disposition.isNpcOnlyItem(held.inventory[1049]), false);
        const sale = Disposition.saleCandidates(held, { allowPreTradeCleanup: true });
        assert.equal(sale.find((row) => row.selfId === 1049).count, 1, 'keep the first own book; surplus is real board stock');
        assert.equal(Disposition.skillBookSlotCount(held, sale), 0, 'market books do not force NPC cleanup');
        const incoming = Catalog.applyTraining({ ...held, sp: 1500 }, paid);
        assert.equal(incoming.sp, 1260); assert.equal(incoming.inventory[1049].amount, 1);
        const instanced = Catalog.applyTraining({ ...held, inventory: { 1049: { ...held.inventory[1049],
            instances: [{ id: paid.consumedBooks[0].objectId, selfId: 1049, amount: 2 }] } } }, paid);
        assert.equal(instanced.inventory[1049].instances[0].amount, 1, 'the physical instance mirrors the paid remainder');

        // The public bot path stops an unaffordable rank; it cannot skip it
        // and award a later rank from the character's level alone.
        await new Skillset().awardSkills(id, 10, 14, { botTraining: true });
        assert.equal((await Database.fetchSkill(id, 1184))[0].level, second.level);
        assert.equal((await Database.fetchItems(id))[0].amount, 1);
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
            assert.equal(session.actor.fetchSp(), 100500 - trained.spentSp);
            assert.equal((await Database.fetchCharacters('bot_pop_books'))[0].sp, session.actor.fetchSp(),
                'SP earned during learning survives; queued hot writes cannot refund an earlier rank');
            assert.equal((await Database.fetchItems(id)).length, 0);
            assert.equal(session.actor.backpack.fetchItems().length, 0);
            assert.equal(session.actor.skillset.fetchSkill(1184).fetchLevel(), (await Database.fetchSkill(id, 1184))[0].level);
        } finally { Data.skillTree = treeSource; Database.learnBotSkill = realLearn; }
        console.log('Bot skill books: real SQLite cost/rollback, first book, rank/SP eligibility, public training, board reservation and authoritative cold kit passed');
    } finally {
        await Database.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
