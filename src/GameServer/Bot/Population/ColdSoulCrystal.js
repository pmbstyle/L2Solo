'use strict';
const Native = require('../../Items/SoulCrystalProgression');
const ItemIndex = require('../../Item/ItemTemplateIndex');
function single(state) {
    const held = Object.values(state.inventory || {}).filter(item => Native.catalog.crystals[item.selfId] && item.amount > 0);
    if (held.length !== 1 || held[0].amount !== 1) return null;
    const instance = held[0].instances?.[0];
    return instance?.id ? { ...held[0], ...instance, selfId: held[0].selfId } : null;
}
function tryCast(fighter, mob, mobHp, at) {
    const item = single(fighter.state), rule = Native.catalog.npcs[mob.selfId];
    if (fighter.soulCrystalMark || !fighter.state.stats?.soulCrystalQuest || !item || !rule
        || rule.maxStage > 10 || mobHp <= 0 || mobHp > mob.maxHp / 2) return false;
    const metadata = Native.catalog.crystals[item.selfId];
    if (metadata.stage >= rule.maxStage) return false;
    const native = invoke('GameServer/Bot/Population/ColdCombatProfile').skillSnapshotsFromRecords([{selfId:2096,level:1}])[0];
    if (!native || Number(fighter.cooldowns[2096] || 0) > at) return false;
    const flattened = native;
    const mp = Number(flattened.mpConsume ?? flattened.mp ?? 0);
    if (fighter.vitals.mp < mp) return false;
    fighter.vitals.mp -= mp;
    const hitTime = Math.max(1, Number(flattened.hitTime || flattened.hit_time || 1000));
    fighter.readyAt += hitTime;
    fighter.cooldowns[2096] = at + Number(flattened.reuseDelay || flattened.reuse || 0);
    fighter.skillUses++;
    fighter.soulCrystalMark = { objectId: item.id, fromId: item.selfId, absorbedHp: mobHp, maxHp: mob.maxHp, skillId: 2096, completeAt: at + hitTime };
    return true;
}
function outcome(fighter, mob, roll, { boss = false, requiredMark = null, at = Infinity } = {}) {
    const item = single(fighter.state), rule = Native.catalog.npcs[mob.selfId];
    if (!rule || !fighter.state.stats?.soulCrystalQuest || fighter.vitals.hp <= 0 || !item) return null;
    const mark = requiredMark || fighter.soulCrystalMark;
    if (!boss && ( !mark || Number(mark.completeAt || 0) > at || mark.objectId !== item.id || mark.fromId !== item.selfId)) return null;
    const metadata = Native.catalog.crystals[item.selfId];
    const result = Native.outcomeFor(rule, metadata.stage, mob.selfId, roll);
    if (result === 'refused' || result === 'failed') return null;
    const toId = result === 'success' ? metadata.nextId : metadata.brokenId;
    const source = ItemIndex.find(invoke('GameServer/DataCache').items, toId);
    if (!source) throw Error('missing_cold_soul_crystal_template');
    const inventory = { ...fighter.state.inventory };
    delete inventory[item.selfId];
    inventory[toId] = { ...item, selfId: toId, name: source.template.name, amount: 1,
        instances: [{ id: item.id, amount: 1, equipped: false, slot: 0, enchant: 0 }] };
    fighter.state.inventory = inventory;
    const change = { ...mark, objectId: item.id, fromId: item.selfId, toId, npcId: mob.selfId,
        roll, skillId: 2096, boss };
    fighter.soulCrystals ||= []; fighter.soulCrystals.push(change);
    return change;
}
module.exports = { single, tryCast, outcome };
