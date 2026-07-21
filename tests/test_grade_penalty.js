const assert = require('assert');

require('../src/Global');

const C4GradePenalty = invoke('GameServer/Items/C4GradePenalty');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function item(rank, equipped = true) {
    return { fetchRank: () => rank, fetchEquipped: () => equipped };
}

function actor(items, expertise = 0) {
    return {
        effects: {},
        expertisePenalty: 0,
        backpack: { fetchItems: () => items },
        skillset: { fetchSkill: (id) => id === 239 ? { fetchLevel: () => expertise } : null },
        fetchExpertisePenalty() { return this.expertisePenalty; },
        setExpertisePenalty(value) { this.expertisePenalty = value; }
    };
}

const novice = actor([item('C')]);
assert.strictEqual(C4GradePenalty.sync(novice), true);
assert.strictEqual(novice.fetchExpertisePenalty(), 2);
assert.strictEqual(EffectStore.list(novice)[0].id, 4267);
assert.strictEqual(EffectStore.list(novice)[0].stats.pAtkSpdMul, 0.22);
assert.strictEqual(EffectStore.list(novice)[0].stats.expMul, 0.22);

const qualified = actor([item('C')], 2);
assert.strictEqual(C4GradePenalty.sync(qualified), false);
assert.strictEqual(EffectStore.list(qualified).length, 0);

// Login first calculates the actor before the asynchronous skillbook load.
// Once Expertise arrives, the second calculation must remove that temporary
// penalty instead of leaving movement speed at the penalized value.
const loginActor = actor([item('C')]);
assert.strictEqual(C4GradePenalty.sync(loginActor), true);
loginActor.skillset.fetchSkill = (id) => id === 239 ? { fetchLevel: () => 2 } : null;
assert.strictEqual(C4GradePenalty.sync(loginActor), true);
assert.strictEqual(loginActor.fetchExpertisePenalty(), 0);
assert.strictEqual(EffectStore.list(loginActor).length, 0);

const mixedEquipment = actor([item('D'), item('A'), item('S', false)], 1);
assert.strictEqual(C4GradePenalty.penalty(mixedEquipment), 3, 'C4 uses the highest equipped item grade');
C4GradePenalty.sync(mixedEquipment);
mixedEquipment.backpack.fetchItems = () => [item('D')];
assert.strictEqual(C4GradePenalty.sync(mixedEquipment), true);
assert.strictEqual(mixedEquipment.fetchExpertisePenalty(), 0);
assert.strictEqual(EffectStore.list(mixedEquipment).length, 0);

console.log('grade penalty tests passed');
