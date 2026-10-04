const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const ItemTemplateIndex = require('../src/GameServer/Item/ItemTemplateIndex');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
Data.init();

// NPC templates are looked up through the shared catalog index; it must return
// the same template a linear Array.find would, for every id and id form.
for (const npc of Data.npcs) {
    const first = Data.npcs.find((candidate) => Number(candidate.selfId) === Number(npc.selfId));
    assert.strictEqual(ItemTemplateIndex.find(Data.npcs, npc.selfId), first);
    assert.strictEqual(ItemTemplateIndex.find(Data.npcs, String(npc.selfId)), first);
}
assert.strictEqual(ItemTemplateIndex.find(Data.npcs, undefined), undefined);
assert.strictEqual(ItemTemplateIndex.find(Data.npcs, 0), undefined);

// A cold fight picks its mob without scanning the NPC list.
const mob = Data.npcs.find((npc) => npc.template?.kind === 'Monster' && Number(npc.template?.level) === 20 && !npc.template?.raidBoss);
const spot = { npcEntries: [{ selfId: mob.selfId, count: 3 }] };
const find = Data.npcs.find;
let scans = 0;
Data.npcs.find = function(...args) { scans++; return find.apply(this, args); };
try {
    const picked = ColdCombatProfile.npcForSpot(spot, () => 0.5);
    assert.strictEqual(Number(picked?.selfId), Number(mob.selfId));
    assert.strictEqual(scans, 0, 'npcForSpot must not scan DataCache.npcs');
} finally {
    Data.npcs.find = find;
}
console.log('test_npc_template_lookup: ok');
