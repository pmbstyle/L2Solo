'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-admission-'));
const previous = { cwd: process.cwd(), config: process.env.L2NODE_CONFIG_FILE,
    shared: process.env.L2NODE_SHARED_CONFIG_FILE };
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(directory, 'world.sqlite')}\nhistoryPath=${path.join(directory, 'history.sqlite')}\n`);
process.chdir(root);
require(path.join(root, 'src/Global'));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Catalog = invoke('GameServer/Skills/SkillBookCatalog');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

let generation = Object.freeze({ serial: 1 });
let stopping = false;
function restart() {
    stopping = true;
    generation = Object.freeze({ serial: generation.serial + 1 });
    stopping = false;
}
function guardFor(expected, fault, observe = () => {}) {
    return () => {
        observe();
        if (stopping || generation !== expected) throw fault;
    };
}
async function seed(index) {
    const account = `bot_mutation_${index}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `Mutation${index}`, race: 0, classId: 10,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 })).insertId);
    await Database.updateCharacterExperience(id, 14, Number(Data.experience[13]) + 1, 10000);
    await Database.setItem(id, { selfId: 1152, name: 'Spellbook: Heal', amount: 2 });
    return { id, account };
}
async function snapshot(character) {
    return { characters: await Database.fetchCharacters(character.account), items: await Database.fetchItems(character.id),
        skills: await Database.fetchSkills(character.id), recipes: await Database.execute([
            'SELECT * FROM character_recipes WHERE characterId = ? ORDER BY recipeId', [character.id]]) };
}
async function rejectedIdentity(promise, expected) {
    let threw = false, actual;
    try { await promise; } catch (error) { threw = true; actual = error; }
    assert(threw, 'retired native mutation must reject');
    assert.equal(actual, expected, 'the exact caller guard failure is preserved');
}

async function returningMode() {
    const character = await seed(6);
    const original = JSON.stringify({ source: 'original', value: 1 });
    await Database.execute(['INSERT INTO bot_life_state(characterId, statsJson) VALUES (?, ?)', [character.id, original]]);
    const row = () => Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [character.id]]);
    const before = await row(), expected = generation;
    const fault = Error('returning_source_retired');
    let barrierRan = false, checks = 0;
    await rejectedIdentity(Database.withMutationAdmission(guardFor(expected, fault, () => {
        checks++; assert(barrierRan, 'the queued predecessor read retires the source before physical RETURNING SQL');
    }), () => {
        // A real queued read runs first; its observational completion turns
        // over the source before the already-enqueued lifecycle save executes.
        const barrier = Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [character.id],
            { onTiming() { barrierRan = true; restart(); } }], 'mutation-test:returning-predecessor');
        const save = Database.saveBotLifeState(['UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?',
            [JSON.stringify({ source: 'retired', value: 2 }), character.id]]);
        return Promise.all([barrier, save]);
    }), fault);
    assert.equal(checks, 1);
    assert.deepEqual(await row(), before, 'UPDATE RETURNING via native one().get cannot bypass scope admission');
    const fresh = JSON.stringify({ source: 'fresh', value: 3 });
    const saved = await Database.withMutationAdmission(guardFor(generation, Error('fresh_returning_retired')), () =>
        Database.saveBotLifeState(['UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?', [fresh, character.id]]));
    assert.equal(saved.affectedRows, 1); assert.equal(saved.statsJson, fresh);
    assert.equal((await row())[0].statsJson, fresh);
    console.log('PASS actual lifecycle UPDATE RETURNING refuses queued old scope and allows fresh scope');
}

async function main() {
    try {
        Data.init(); Database.init(); assert(Database.isReady());
        if (process.argv.includes('--returning')) { await returningMode(); return; }
        const training = Catalog.nextTraining(10, 14, 1011);
        assert.equal(training.bookId, 1152); assert.equal(training.sp, 160);
        const healthy = await seed(1);
        const expected = generation;
        let checks = 0;
        const learned = await Database.withMutationAdmission(guardFor(expected, Error('healthy_retired'), () => checks++), async () => {
            await Promise.resolve();
            return Database.learnBotSkill(healthy.id, 1011, training.level);
        });
        assert.equal(learned.learned, true); assert.equal(learned.spentSp, 160);
        assert.equal(checks, 3, 'each actual SP/book/rank write checks the captured scope');
        const paid = await snapshot(healthy);
        assert.equal(paid.characters[0].sp, 9840); assert.equal(paid.items[0].amount, 1);
        assert.equal(paid.skills[0].level, training.level);
        console.log('PASS healthy awaited native SP/book/rank writes');

        const awaited = await seed(2), beforeAwait = await snapshot(awaited);
        const entered = deferred(), resume = deferred(), oldGeneration = generation;
        const stale = Error('old_generation_retired');
        const old = Database.withMutationAdmission(guardFor(oldGeneration, stale), async () => {
            entered.resolve(); await resume.promise;
            return Database.learnBotSkill(awaited.id, 1011, training.level);
        });
        await entered.promise;
        restart();
        const currentGeneration = generation;
        const fresh = Database.withMutationAdmission(guardFor(currentGeneration, Error('new_generation_retired')), async () => {
            await Promise.resolve();
            return Database.setItem(healthy.id, { selfId: 1864, name: 'Stem', amount: 3 });
        });
        const unwrapped = Database.setCharacterRecipe(healthy.id, 1, 'common');
        resume.resolve();
        await Promise.all([rejectedIdentity(old, stale), fresh, unwrapped]);
        assert.deepEqual(await snapshot(awaited), beforeAwait);
        const isolated = await snapshot(healthy);
        assert.equal(isolated.items.find(item => item.selfId === 1864).amount, 3);
        assert.equal(isolated.recipes.length, 1, 'unwrapped queued writes do not inherit another scope');
        console.log('PASS stop/start awaited continuation refusal and concurrent scope isolation');

        const queued = await seed(3), beforeQueued = await snapshot(queued);
        const queueGeneration = generation, queueFault = Error('enqueued_source_retired');
        await rejectedIdentity(Database.withMutationAdmission(guardFor(queueGeneration, queueFault), () => {
            const pending = Database.setCharacterRecipe(queued.id, 1, 'common');
            restart();
            return pending;
        }), queueFault);
        assert.deepEqual(await snapshot(queued), beforeQueued, 'retirement after enqueue refuses before actual SQL');
        console.log('PASS queued run checks admission at native execution');

        const flushed = await seed(4), beforeFlush = await snapshot(flushed);
        const flushEntered = deferred(), flushResume = deferred();
        const flushGeneration = generation, flushFault = Error('flush_source_retired');
        let flushCalls = 0;
        Database.registerCharacterWriteFlush(async id => {
            assert.equal(id, flushed.id);
            flushCalls++; flushEntered.resolve(); await flushResume.promise;
            return Database.applyBufferedCharacterState(id, { character: { locX: 321 } });
        });
        const flushing = Database.withMutationAdmission(guardFor(flushGeneration, flushFault), () =>
            Database.learnBotSkill(flushed.id, 1011, training.level));
        await flushEntered.promise;
        restart(); flushResume.resolve();
        await rejectedIdentity(flushing, flushFault);
        Database.registerCharacterWriteFlush(null);
        assert.equal(flushCalls, 1);
        assert.deepEqual(await snapshot(flushed), beforeFlush, 'awaited flush cannot write or continue into skill payment');
        console.log('PASS native registered flush retains its original admission across await');

        const transaction = await seed(5), beforeTransaction = await snapshot(transaction);
        const transactionGeneration = generation, rollbackFault = Error('retired_before_rank');
        let mutationChecks = 0;
        await rejectedIdentity(Database.withMutationAdmission(guardFor(transactionGeneration, rollbackFault, () => {
            if (++mutationChecks === 3) restart();
        }), () => Database.learnBotSkill(transaction.id, 1011, training.level)), rollbackFault);
        assert.equal(mutationChecks, 3, 'refusal occurs after actual SP and book writes, before rank SQL');
        assert.deepEqual(await snapshot(transaction), beforeTransaction, 'native transaction rolls back both earlier writes');
        const recoveredGeneration = generation;
        const recovered = await Database.withMutationAdmission(guardFor(recoveredGeneration, Error('recovery_retired')),
            () => Database.learnBotSkill(transaction.id, 1011, training.level));
        assert.equal(recovered.learned, true);
        await Database.setCharacterRecipe(transaction.id, 1, 'common');
        const after = await snapshot(transaction);
        assert.equal(after.characters[0].sp, 9840); assert.equal(after.items[0].amount, 1);
        assert.equal(after.skills.length, 1); assert.equal(after.recipes.length, 1);
        console.log('PASS mid-multiwrite rollback and fresh/unwrapped recovery');
        await returningMode();
    } finally {
        Database.registerCharacterWriteFlush(null);
        await Database.close();
        assert.equal(Database.isReady(), false);
        process.chdir(previous.cwd);
        if (previous.config === undefined) delete process.env.L2NODE_CONFIG_FILE;
        else process.env.L2NODE_CONFIG_FILE = previous.config;
        if (previous.shared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE;
        else process.env.L2NODE_SHARED_CONFIG_FILE = previous.shared;
        fs.rmSync(directory, { recursive: true, force: true });
        assert.equal(fs.existsSync(directory), false);
        console.log('CLEANUP closed database and deleted generated world/history paths');
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
