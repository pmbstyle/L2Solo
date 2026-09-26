// Certification for the C4 beginner-shot reward and the five hunting quests
// that carry it (Q257, Q260, Q265, Q273, Q293).
//
// The eligibility model is the part worth proving. C4 decides eligibility once,
// at character creation, and then counts grants character-wide. This test drives
// the real creation path, the real migration default, the real quest handlers and
// a real database, and asserts that the shots cannot be farmed by restarting a
// repeatable quest, by talking twice, or by a second character on the account.
const assert = require('node:assert/strict');
const { createWorld, withRandom, Database } = require('./helpers/c4QuestHarness');

const BeginnerReward = require('../src/GameServer/Quest/BeginnerReward');
const Definitions = require('../src/GameServer/Quest/BeginnerQuestDefinitions');
const byId = id => Definitions.find(d => d.id === id);

const SOULSHOT = 5789;
const SPIRITSHOT = 5790;

// Race ids: 0 human, 1 elf, 2 dark elf, 3 orc, 4 dwarf.
const CHARACTERS = [
    { id: 257, race: 0, classId: 0, level: 10, newbie: 1 },
    { id: 260, race: 1, classId: 18, level: 10, newbie: 1 },
    { id: 265, race: 2, classId: 31, level: 10, newbie: 1 },
    { id: 273, race: 3, classId: 49, level: 10, newbie: 1 },
    { id: 293, race: 4, classId: 53, level: 10, newbie: 1 },
    // A human mystic, to prove the spiritshot branch.
    { id: 300, race: 0, classId: 10, level: 10, newbie: 1 },
    // An Orc mystic, whom the reference deliberately pays in soulshots.
    { id: 301, race: 3, classId: 49, level: 10, newbie: 1 },
    // Not eligible: created as a later character on its account.
    { id: 302, race: 0, classId: 0, level: 10, newbie: 0 },
    // Unknown: predates the flag. Policy decides.
    { id: 303, race: 0, classId: 0, level: 10, newbie: -1 },
    { id: 304, race: 0, classId: 0, level: 10, newbie: 1 }
];

async function main() {
    const world = await createWorld(CHARACTERS, 'c4-beginner');
    try {
        await migrationIsSafeForExistingDatabases();
        await creationDecidesEligibility(world);
        await eligibilityPolicy(world);
        await grantIsOncePerCharacter(world);
        await mysticBranches(world);
        await huntingQuestPayouts(world);
        console.log('C4 beginner quests: creation-time eligibility, unknown-character policy, '
            + 'once-per-character receipt, mystic branches and bounty payouts passed');
    } finally {
        await world.close();
    }
}

// A database written before the flag existed must keep its characters, and must
// record them as UNKNOWN rather than inventing an eligibility for them.
async function migrationIsSafeForExistingDatabases() {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-beginner-migration-'));
    const file = path.join(directory, 'legacy.sqlite');
    try {
        const legacy = new DatabaseSync(file);
        legacy.exec(require('./helpers/legacyCharacterSchema').legacySchema());
        const columnsBefore = legacy.prepare('PRAGMA table_info(characters)').all().map(c => c.name);
        assert.ok(!columnsBefore.includes('newbie'), 'the legacy schema really lacks the flag');
        legacy.exec("INSERT INTO accounts(username,password) VALUES ('legacy','test')");
        legacy.exec(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (9001,'legacy','Veteran',0,0,40,0,0,187,74,187,74,0,0,0,0,0,0,0)`);
        legacy.close();

        const previousPath = options.default.Database.path;
        await Database.close();
        options.default.Database.path = file;
        Database.init();
        try {
            const [row] = await Database.execute(['SELECT newbie, newbieShotsReceived, level FROM characters WHERE id = 9001']);
            assert.equal(Number(row.level), 40, 'the existing character survived the migration');
            assert.equal(Number(row.newbie), BeginnerReward.UNKNOWN,
                'a character predating the flag is recorded as unknown, not guessed from its level');
            assert.equal(Number(row.newbieShotsReceived), 0, 'its receipt starts empty');
        } finally {
            await Database.close();
            options.default.Database.path = previousPath;
            Database.init();
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
}

// Eligibility is decided at creation from account character count, never guessed.
async function creationDecidesEligibility(world) {
    await Database.execute(["INSERT INTO accounts(username,password) VALUES ('fresh','test')"]);
    const first = await Database.createCharacter('fresh', {
        name: 'FirstBorn', race: 0, classId: 0, maxHp: 187, maxMp: 74,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    const second = await Database.createCharacter('fresh', {
        name: 'SecondBorn', race: 0, classId: 0, maxHp: 187, maxMp: 74,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    const rows = await Database.execute(["SELECT name, newbie, newbieShotsReceived FROM characters WHERE username = 'fresh' ORDER BY id"]);
    assert.equal(rows.length, 2, 'both characters were created');
    assert.equal(Number(rows[0].newbie), BeginnerReward.ELIGIBLE,
        "an account's first character is eligible");
    assert.equal(Number(rows[1].newbie), BeginnerReward.NOT_ELIGIBLE,
        'a later character on the same account is not eligible');
    assert.equal(Number(rows[0].newbieShotsReceived), 0, 'a new character has received nothing');
    assert.ok(first && second, 'creation returned rows');
}

// The three states must be distinguishable, and the unknown state is policy-driven.
async function eligibilityPolicy(world) {
    const actor = flag => ({ newbie: flag, newbieShotsReceived: 0, fetchRace: () => 0, fetchClassId: () => 0 });
    const original = options.default.General.newbieRewardPolicy;
    try {
        options.default.General.newbieRewardPolicy = 'strict';
        assert.equal(BeginnerReward.isEligible(actor(BeginnerReward.ELIGIBLE)), true);
        assert.equal(BeginnerReward.isEligible(actor(BeginnerReward.NOT_ELIGIBLE)), false);
        assert.equal(BeginnerReward.isEligible(actor(BeginnerReward.UNKNOWN)), false,
            'strict policy refuses characters whose eligibility cannot be proven');

        options.default.General.newbieRewardPolicy = 'grant';
        assert.equal(BeginnerReward.isEligible(actor(BeginnerReward.UNKNOWN)), true,
            'grant policy admits unknown characters');
        assert.equal(BeginnerReward.isEligible(actor(BeginnerReward.NOT_ELIGIBLE)), false,
            'grant policy still refuses a proven-ineligible character');

        options.default.General.newbieRewardPolicy = 'always';
        assert.equal(BeginnerReward.isEligible(actor(BeginnerReward.NOT_ELIGIBLE)), true,
            'the always override admits everyone, matching the reference config');
    } finally {
        options.default.General.newbieRewardPolicy = original;
    }

    // Under the default policy an unknown character earns adena but no shots.
    const unknown = await world.session(303);
    assert.ok(await world.event(unknown, 257, 'start', 7039));
    await withRandom([0, 0, 0], () => world.kill(unknown, 6));
    await world.talk(unknown, 7039);
    assert.equal(await world.amount(303, SOULSHOT), 0,
        'an unknown character receives no beginner shots under the strict default');
    assert.ok(await world.amount(303, 57) > 0, 'but is still paid for the trophy');

    const ineligible = await world.session(302);
    assert.ok(await world.event(ineligible, 257, 'start', 7039));
    await withRandom([0, 0, 0], () => world.kill(ineligible, 6));
    await world.talk(ineligible, 7039);
    assert.equal(await world.amount(302, SOULSHOT), 0,
        'a proven-ineligible character receives no beginner shots');
}

// The counter is character-wide and survives restarts, so the grant is once only.
async function grantIsOncePerCharacter(world) {
    let session = await world.session(304);
    assert.ok(await world.event(session, 257, 'start', 7039));
    await withRandom([0, 0, 0], () => world.kill(session, 6));
    await world.talk(session, 7039);
    assert.equal(await world.amount(304, SOULSHOT), 6000, 'the first cash-out grants 6000 soulshots');
    assert.equal(Number((await world.character(304)).newbieShotsReceived), 1, 'the receipt is recorded');

    // Hunting again within the same quest run must not pay a second grant.
    await withRandom([0, 0, 0], () => world.kill(session, 6));
    await world.talk(session, 7039);
    assert.equal(await world.amount(304, SOULSHOT), 6000, 'a second cash-out grants no more shots');

    // Abandoning and restarting the repeatable quest must not clear the receipt.
    await world.event(session, 257, 'quit', 7039);
    session = await world.reopen(304);
    assert.equal(Number((await world.character(304)).newbieShotsReceived), 1,
        'the receipt survives quitting and a restart');
    assert.ok(await world.event(session, 257, 'start', 7039), 'the bounty can be taken again');
    await withRandom([0, 0, 0], () => world.kill(session, 6));
    await world.talk(session, 7039);
    assert.equal(await world.amount(304, SOULSHOT), 6000,
        'restarting the repeatable bounty cannot farm a second beginner grant');

    // A different beginner quest must also see the counter as spent.
    assert.equal(BeginnerReward.plan({ newbie: 1, newbieShotsReceived: 1, fetchRace: () => 0, fetchClassId: () => 0 },
        byId(260).beginnerReward), null, 'the hunting group needs a counter of 0');
    // The class-quest group allows a second grant, exactly as the reference does.
    assert.notEqual(BeginnerReward.plan({ newbie: 1, newbieShotsReceived: 1, fetchRace: () => 0, fetchClassId: () => 0 },
        { threshold: 2, soulshots: 7000, spiritshots: 3000 }), null,
        'the class-quest group allows a second grant while the counter is below two');
}

async function mysticBranches(world) {
    const mystic = await world.session(300);
    assert.ok(await world.event(mystic, 257, 'start', 7039));
    await withRandom([0, 0, 0], () => world.kill(mystic, 6));
    await world.talk(mystic, 7039);
    assert.equal(await world.amount(300, SPIRITSHOT), 3000, 'a human mystic receives 3000 spiritshots');
    assert.equal(await world.amount(300, SOULSHOT), 0, 'and no soulshots');

    // The reference pays Orc mystics in soulshots despite their mystic class.
    const orcMystic = await world.session(301);
    assert.ok(await world.event(orcMystic, 273, 'start', 7566));
    await withRandom([0, 0], () => world.kill(orcMystic, 311));
    await world.talk(orcMystic, 7566);
    assert.equal(await world.amount(301, SOULSHOT), 6000, 'an Orc mystic receives soulshots');
    assert.equal(await world.amount(301, SPIRITSHOT), 0, 'and never spiritshots');
}

// Each bounty must pay exactly the authored unit prices and threshold bonuses.
async function huntingQuestPayouts(world) {
    // Q257: ten orc amulets at 10 adena each plus the 1000 threshold bonus.
    const gilbert = await world.session(257);
    assert.ok(await world.event(gilbert, 257, 'start', 7039), 'Gilbert accepts a level 6 applicant');
    assert.equal(await world.amount(257, 1084), 1, "the Gludio lord's mark is handed over at start");
    for (let i = 0; i < 10; i++) await withRandom([0], () => world.kill(gilbert, 6));
    assert.equal(await world.amount(257, 752), 10, 'ten amulets were collected');
    await world.talk(gilbert, 7039);
    // 10 amulets * 10 adena + 1000 bonus, plus the beginner grant.
    assert.equal(await world.amount(257, 57), 1100, 'Q257 pays 10x10 adena plus the 1000 bonus');
    assert.equal(await world.amount(257, 752), 0, 'the amulets are consumed');
    assert.equal(await world.amount(257, SOULSHOT), 6000, 'Q257 pays the beginner soulshots');

    // Q265: nine shackles are below the threshold, so no bonus is paid.
    const kristin = await world.session(265);
    assert.ok(await world.event(kristin, 265, 'start', 7357), 'Kristin accepts a Dark Elf');
    for (let i = 0; i < 9; i++) await withRandom([0], () => world.kill(kristin, 4));
    await world.talk(kristin, 7357);
    assert.equal(await world.amount(265, 57), 9 * 12, 'nine shackles pay 12 each with no bonus');

    // Q273: exclusive soulstone outcomes, and the richer bonus when a red stone
    // accompanies ten black ones.
    const varkees = await world.session(273);
    assert.ok(await world.event(varkees, 273, 'start', 7566), 'Varkees accepts an Orc');
    for (let i = 0; i < 10; i++) await withRandom([0], () => world.kill(varkees, 311));
    assert.equal(await world.amount(273, 1475), 10, 'a low roll always yields the black soulstone');
    await withRandom([0.95], () => world.kill(varkees, 311));
    assert.equal(await world.amount(273, 1476), 1, 'a high roll yields the red soulstone instead');
    await world.talk(varkees, 7566);
    // 10 black * 3 + 1 red * 10 + 1500 + 300.
    assert.equal(await world.amount(273, 57), 30 + 10 + 1500 + 300,
        'Q273 pays both threshold bonuses when a red soulstone is present');

    // Q293: fragments become a map at Chinchirin, and maps are worth 500 each.
    const filaur = await world.session(293);
    assert.ok(await world.event(filaur, 293, 'start', 7535), 'Filaur accepts a Dwarf');
    for (let i = 0; i < 4; i++) await withRandom([0.5], () => world.kill(filaur, 446));
    assert.equal(await world.amount(293, 1489), 4, 'four torn fragments were collected');
    assert.equal(await world.event(filaur, 293, 'map', 7539), true, 'Chinchirin assembles the fragments');
    assert.equal(await world.amount(293, 1489), 0, 'the fragments are consumed');
    assert.equal(await world.amount(293, 1490), 1, 'one hidden vein map is produced');
    await withRandom([0.2], () => world.kill(filaur, 446));
    assert.equal(await world.amount(293, 1488), 1, 'a mid roll yields chrysolite ore');
    await world.talk(filaur, 7535);
    // 1 ore * 5 + 1 map * 500, no threshold bonus at these amounts.
    assert.equal(await world.amount(293, 57), 5 + 500, 'Q293 pays ore and map unit prices');

    // Q260: the two Kaboo trophy tiers have different unit prices.
    const rayen = await world.session(260);
    assert.ok(await world.event(rayen, 260, 'start', 7221), 'Rayen accepts an Elf');
    await withRandom([0], () => world.kill(rayen, 468));
    await withRandom([0], () => world.kill(rayen, 471));
    await world.talk(rayen, 7221);
    assert.equal(await world.amount(260, 57), 12 + 30, 'Q260 pays 12 per amulet and 30 per necklace');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
