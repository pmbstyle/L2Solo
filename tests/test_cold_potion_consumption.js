const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-potion-consumption.sqlite');
const POTION = 1060; // Lesser Healing Potion
const at = 1_750_000_000_000;

function clean() {
    const history = databasePath.replace(/\.sqlite$/, '.history.sqlite');
    for (const file of [databasePath, history]) {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    }
}

function item(selfId, amount, name) {
    return { selfId, name, amount, enchant: 0, equipped: false, slot: 0 };
}

function fighter(state, hp) {
    return {
        ...state,
        level: 12,
        activity: 'hunting',
        vitals: { hp, maxHp: 500, mp: 200, maxMp: 200 },
        stats: {
            ...(state.stats || {}),
            classId: 0,
            coldCombat: {
                version: 1, classId: 0,
                base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
                equipment: { weaponKind: 'Weapon.Sword', pAtk: 40, pAtkRnd: 5, mAtk: 10, atkSpd: 379, critical: 0,
                    accur: 100, pDef: 60, mDef: 30, evasion: 0, bonusMp: 0, shieldPDef: 0 },
                effects: [], skills: []
            }
        },
        party: { role: 'dps' }
    };
}

function seeded(seed) {
    let a = seed;
    return () => {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const spot = { id: 'potion_field', name: 'Potion field', avgLevel: 14, density: 3, npcSelfIds: [396],
    rewards: { exp: 10, sp: 2, adenaMin: 1, adenaMax: 1 }, mob: { hp: 1, damage: 1 } };

// A solo fight against a real datapack mob (Brae Orc Fighter) that drinks a
// potion and survives; the seed sweep is deterministic.
function soloFightWithPotion(base) {
    for (let seed = 1; seed < 400; seed += 1) {
        const state = fighter(base, 344);
        const result = Solo.resolveSolo({ state, spot, elapsedMs: 60000, timestamp: at, rng: seeded(seed) });
        if (Number(result.debug?.potionsUsed || 0) > 0 && !result.debug?.died) return { state, result };
    }
    throw new Error('no fixture fight drank a potion');
}

async function physicalAmount(characterId, selfId) {
    return (await Database.fetchItems(characterId))
        .filter((row) => Number(row.selfId) === selfId)
        .reduce((sum, row) => sum + Number(row.amount), 0);
}

(async () => {
    clean();
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    DataCache.init();
    World.user = { sessions: [], revision: 0 };
    await LifeState.init();

    await Database.createAccount('bot_potion', 'pw');
    const id = Number((await Database.createCharacter('bot_potion', {
        name: 'PotionDrinker', race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: -12000, locY: 122000, locZ: -3000
    })).insertId);
    await Database.setItem(id, item(POTION, 5, 'Lesser Healing Potion'));
    await Database.setItem(id, item(57, 100, 'Adena'));
    const base = await LifeState.upsertState({
        characterId: id, accountName: 'bot_potion', name: 'PotionDrinker', level: 12, adena: 100,
        phase: 'cold', activity: 'hunting', currentRegion: 'Gludio', spotId: spot.id,
        loc: { locX: -12000, locY: 122000, locZ: -3000 },
        inventory: LifeState.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 }, stats: { generatedCold: true }, timing: {}
    }, 'test_potion_seed');

    const { state, result } = soloFightWithPotion(base);
    const drunk = Number(result.debug.potionsUsed);
    assert.deepStrictEqual(result.debug.drunkPotions, { [POTION]: drunk }, 'the resolver reports the bottles it drank by item');
    assert.strictEqual(state.inventory[POTION].amount, 5, 'the resolver drinks from its own copy');

    const projected = await LifeState.prepareResolve(state, result, { persist: false, timestamp: at });
    assert.strictEqual(projected.inventory[POTION].amount, 5 - drunk, 'the worker projection debits the drunk potions');

    const committed = await LifeState.applyResolve(state, result);
    assert.strictEqual(committed.inventory[POTION].amount, 5 - drunk, 'the commit debits the drunk potions');
    const [life] = await Database.execute(['SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', [id]]);
    assert.strictEqual(JSON.parse(life.inventorySummary)[POTION].amount, 5 - drunk, 'the stored summary keeps the lower count');
    assert.strictEqual(await physicalAmount(id, POTION), 5 - drunk, 'the items table keeps the lower count');

    // The party path is unchanged: its member results carry no solo potion
    // count, so the commit leaves the member's stock as it was.
    const members = [901, 902].map((characterId) => ({ ...fighter(base, 150), characterId, activity: 'grouped',
        party: { partyId: 'potion-party', role: 'dps' } }));
    const party = { partyId: 'potion-party', memberIds: [901, 902], leaderId: 901, spotId: spot.id, stats: {} };
    const partyResult = Party.resolve({ party, members, spot, elapsedMs: 60000, timestamp: at, rng: seeded(7) });
    for (const member of partyResult.memberResults) {
        assert.strictEqual(member.result.debug.drunkPotions, undefined, 'a party member result carries no solo potion count');
        const memberProjection = await LifeState.prepareResolve(member.state, member.result,
            { persist: false, timestamp: at, projectClassProgression: true });
        assert.strictEqual(memberProjection.inventory[POTION].amount, member.state.inventory[POTION].amount);
    }

    await Database.close();
    clean();
    console.log('Cold potions: a solo resolve debits the potions it drank from the stored stock; party unchanged');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
