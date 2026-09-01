const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');

DataCache.init();

function inventory(entries) {
    return Object.fromEntries(entries.map(([selfId, amount]) => [String(selfId), { selfId, amount }]));
}

assert.strictEqual(
    HealingPotionStock.selectPotion(inventory([[1060, 2]]), 36, 100, 'dps'),
    null,
    'a melee bot above the low-HP threshold must preserve its potion'
);
assert.strictEqual(
    HealingPotionStock.selectPotion(inventory([[1060, 2]]), 35, 100, 'dps').selfId,
    1060,
    'a melee bot may use a potion once HP reaches the combat threshold'
);
assert.strictEqual(
    HealingPotionStock.selectPotion(inventory([[1061, 2]]), 30, 100, 'archer'),
    null,
    'a ranged bot must keep the stricter emergency threshold'
);
assert.strictEqual(
    HealingPotionStock.selectPotion(inventory([[1060, 1], [1061, 1], [1539, 1]]), 300, 2000, 'tank').selfId,
    1539,
    'a large missing-HP pool should use the smallest owned potion capable of meaningful recovery'
);
assert.strictEqual(
    HealingPotionStock.selectPotion(inventory([[1061, 1], [1540, 1]]), 10, 100, 'dps').selfId,
    1540,
    'Quick Healing Potion must remain reserved for genuinely critical HP'
);

const cautiousRestock = HealingPotionStock.restockPlan({
    level: 20,
    adena: 2000,
    stats: { classId: 0 },
    inventory: inventory([[57, 2000]])
}, { unitPrice: 330 });
assert.strictEqual(cautiousRestock.amount, 0, 'restocking must not touch the operational wallet reserve');
assert.strictEqual(cautiousRestock.cost, 0);
assert.strictEqual(cautiousRestock.reserve, 5000, 'level-scaled reserves must protect progression money even when no potion is affordable');

const affordableRestock = HealingPotionStock.restockPlan({
    level: 20,
    adena: 10000,
    stats: { classId: 0 },
    inventory: inventory([[57, 10000], [1061, 2]])
}, { unitPrice: 330 });
assert.strictEqual(affordableRestock.amount, 6, 'melee restocking must stop at its small target stock');
assert.strictEqual(affordableRestock.cost, 1980);
assert(affordableRestock.adena - affordableRestock.cost >= affordableRestock.reserve);

const coldInventory = inventory([[1060, 2]]);
const coldPotion = HealingPotionStock.consumeColdPotion(coldInventory, 30, 100, 'dps');
assert.strictEqual(coldPotion.selfId, 1060);
assert.strictEqual(coldInventory['1060'].amount, 1, 'background combat must debit the same durable inventory summary');
const coldEffect = HealingPotionStock.coldEffectFor(coldPotion, 1000);
assert.deepStrictEqual(coldEffect.hot, { heal: 16, remaining: 7, intervalMs: 2000, nextAt: 3000 },
    'background combat must retain the native seven-tick C4 healing curve');

function item(selfId, amount, objectId = selfId + 100000) {
    return {
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        fetchId: () => objectId
    };
}

const usedObjectIds = [];
const hotActor = {
    effects: {},
    fetchClassId: () => 0,
    fetchHp: () => 30,
    fetchMaxHp: () => 100,
    state: { fetchDead: () => false, fetchCasts: () => false },
    canUseSkill: () => true,
    backpack: {
        fetchItems: () => [item(1060, 2)],
        buildItemSkill: () => ({ fetchSelfId: () => 2031 }),
        useItem: (_session, objectId) => usedObjectIds.push(objectId)
    }
};
const session = {};
const firstTarget = { fetchId: () => 7001, fetchHp: () => 100, isDead: () => false };
assert.strictEqual(HealingPotionStock.tryUseInCombat(session, hotActor, firstTarget).selfId, 1060);
assert.deepStrictEqual(usedObjectIds, [101060], 'hot combat must use the real inventory object id');
assert.strictEqual(session.lastCombatDecision.action, 'use_healing_potion');
assert.strictEqual(HealingPotionStock.tryUseInCombat(session, hotActor, firstTarget), null,
    'one target must not trigger repeated potion spending');

hotActor.effects.lesser_healing_potion = {
    key: 'lesser_healing_potion',
    id: 2031,
    type: 'buff',
    expiresAt: Date.now() + 10000
};
const secondTarget = { fetchId: () => 7002, fetchHp: () => 100, isDead: () => false };
assert.strictEqual(HealingPotionStock.tryUseInCombat(session, hotActor, secondTarget), null,
    'an active potion HoT must block another bottle even after the target changes');

const coldFighter = {
    characterId: 99001,
    level: 10,
    vitals: { hp: 30, maxHp: 500, mp: 100, maxMp: 100 },
    inventory: inventory([[1060, 2]]),
    stats: {
        classId: 0,
        coldCombat: {
            version: 1,
            classId: 0,
            base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
            equipment: { weaponKind: 'Weapon.Sword', pAtk: 100, pAtkRnd: 0, mAtk: 10, atkSpd: 379, critical: 0, accur: 100, pDef: 100, mDef: 30, evasion: 0, bonusMp: 0, shieldPDef: 0 },
            effects: [],
            skills: []
        }
    },
    party: { role: 'dps' }
};
const coldEncounter = BackgroundResolver.resolvePartyFight({
    members: [coldFighter],
    spot: {
        avgLevel: 1,
        mob: { hp: 1, damage: 1 },
        rewards: { exp: 0, sp: 0, adenaMin: 0, adenaMax: 0 }
    },
    rng: () => 0,
    timestamp: 1_750_000_000_000
});
assert.strictEqual(coldEncounter.debug.potionsUsed, 1, 'background combat must run the potion policy inside a live encounter');
assert.strictEqual(coldEncounter.members[0].state.inventory['1060'].amount, 1,
    'background encounter consumption must be carried into the persisted member state');
assert(coldEncounter.members[0].vitals.hp > coldFighter.vitals.hp,
    'a surviving background fighter must receive the remaining HoT during skipped post-fight time');

console.log('Bot healing potion tests passed');
