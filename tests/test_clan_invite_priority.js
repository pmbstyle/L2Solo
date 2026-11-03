const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const target = process.argv[2] || path.join(__dirname, '../src/GameServer/Bot/AI/BotAvailability.js');
let members = [{ id: 2 }];
let relationshipReason = null;
const memory = { trust: -10, recentlyAbandonedAt: Date.now() };
const dependencies = {
    'GameServer/Bot/AI/BotSocialMemory': {
        getSnapshot: () => memory,
        peekSnapshot: () => memory,
        relationship: () => 'stranger'
    },
    'GameServer/Bot/AI/BotServiceIdentity': { isStaticService: subject => !!subject.staticService },
    'GameServer/SpeckMath': { Point3D: class { distance() { return 100000; } } },
    'GameServer/Social/InteractionMemoryRuntime': { assess: () => ({ ready: true }) },
    'GameServer/Clan/ClanService': { findById: id => id === 77 ? { members } : null },
    // Travel affects the diagnostic location only.
    'GameServer/Bot/Population/ColdTrip': { travellerAnswers: () => false, positionAt: state => state.loc }
};
const context = {
    module: { exports: {} },
    invoke: name => { assert.ok(dependencies[name], name); return dependencies[name]; },
    require: name => {
        assert.equal(name, '../../Social/PlayerPartyRelationship');
        return { combine: () => ({ memory, reason: relationshipReason }) };
    }
};
vm.runInNewContext(fs.readFileSync(target, 'utf8'), context, { filename: target });
const availability = context.module.exports;
const actor = (id, clanId) => ({ fetchId: () => id, fetchClanId: () => clanId,
    fetchLevel: () => 20, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
    isDead: () => false });
const player = { actor: actor(1, 77) };
let cases = 0;
for (const activity of ['dead', 'shopping', 'merchant', 'crafting', 'traveling', 'pk_hunting', 'resting', 'hunting']) {
    for (const stats of [{}, { clanId: 0 }, { clanId: 88 }, { clanId: 77 }]) {
        for (const relation of [null, 'relationship_unloaded', 'relationship_hostile']) {
            relationshipReason = relation;
            const state = { characterId: 2, phase: 'cold', activity, level: 80,
                vitals: { hp: activity === 'dead' ? 0 : 100 }, stats };
            const result = availability.evaluateState(player, state);
            assert.equal(result.clanmate, true, `${activity}: current roster must override stale stats`);
            assert.equal(result.reason, relation || 'relationship_hostile', `${activity}: ${relation}`);
            memory.trust = 0;
            const neutral = availability.evaluateState(player, state);
            assert.equal(neutral.reason, relation || 'level_gap_too_large', 'clan membership cannot bypass level compatibility');
            assert.equal(availability.evaluateState(player, { ...state, level: 20 }).reason, relation || 'available');
            memory.trust = -10;
            assert.equal(availability.evaluateState(player, { ...state, staticService: true }).reason, 'merchant_duty');
            cases++;
        }
    }
}
relationshipReason = 'relationship_hostile';
assert.equal(availability.evaluate(player, { actor: actor(2, 77) }).reason, 'relationship_hostile');
assert.equal(availability.evaluate(player, { actor: actor(2, 88) }).reason, 'relationship_hostile');
relationshipReason = null;
members = [];
memory.trust = 0;
const formerMember = { characterId: 2, activity: 'dead', level: 20, stats: { clanId: 77 }, vitals: { hp: 0 } };
assert.equal(availability.evaluateState(player, formerMember).clanmate, false);
assert.equal(availability.evaluateState(player, formerMember).reason, 'available');
assert.equal(availability.evaluateState({ actor: actor(1, 0) }, formerMember).clanmate, false);
console.log(`Passed ${cases} cold clan invite cases and membership and shared player-invite guards.`);
