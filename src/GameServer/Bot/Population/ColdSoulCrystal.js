'use strict';
const Native = require('../../Items/SoulCrystalProgression');
const ItemIndex = require('../../Item/ItemTemplateIndex');
const BotCrystal = require('../Economy/BotSoulCrystal');
function single(state) {
    const held = Object.values(state.inventory || {}).filter(item => Native.catalog.crystals[item.selfId] && item.amount > 0);
    if (held.length !== 1 || held[0].amount !== 1) return null;
    const instance = held[0].instances?.[0];
    return instance?.id ? { ...held[0], ...instance, selfId: held[0].selfId } : null;
}
function applyInventoryStep(inventory, { fromId, toId, objectId }) {
    const held = inventory[fromId];
    if (held?.instances?.[0]?.id !== objectId) throw Error('cold_soul_crystal_projection_changed');
    const target = ItemIndex.find(invoke('GameServer/DataCache').items, toId);
    if (!target) throw Error('missing_cold_soul_crystal_template');
    const previous = inventory[toId];
    delete inventory[fromId];
    inventory[toId] = previous?.amount > 0
        ? { ...previous, amount: previous.amount + held.amount, instances: [...(previous.instances || []), ...held.instances] }
        : { ...held, selfId: toId, name: target.template.name };
}
function tryCast(fighter, mob, mobHp, at) {
    const rule = Native.catalog.npcs[mob.selfId];
    if (fighter.soulCrystalMark || !fighter.state.stats?.soulCrystalQuest || !rule
        || rule.maxStage > 10 || mobHp <= 0 || mobHp > mob.maxHp / 2) return false;
    const item = single(fighter.state);
    if (!item) return false;
    const metadata = Native.catalog.crystals[item.selfId];
    if (metadata.stage >= rule.maxStage) return false;
    const goal = fighter.state.stats.soulCrystalGoal;
    if (goal && !BotCrystal.canAdvance(fighter.state, goal, item.selfId)) return false;
    const native = invoke('GameServer/Bot/Population/ColdCombatProfile').skillSnapshotsFromRecords([{selfId:2096,level:1}])[0];
    if (!native || Number(fighter.cooldowns[2096] || 0) > at) return false;
    const flattened = native;
    const mp = Number(flattened.mpConsume ?? flattened.mp ?? 0);
    const reserve = goal ? (Number(fighter.vitals.maxMp) || 0) / 4 : 0;
    if (fighter.vitals.mp - mp < reserve) return false;
    fighter.vitals.mp -= mp;
    const hitTime = Math.max(1, Number(flattened.hitTime || flattened.hit_time || 1000));
    fighter.readyAt += hitTime;
    fighter.cooldowns[2096] = at + Number(flattened.reuseDelay || flattened.reuse || 0);
    fighter.skillUses++;
    fighter.soulCrystalMark = { objectId: item.id, fromId: item.selfId, absorbedHp: mobHp, maxHp: mob.maxHp, skillId: 2096, completeAt: at + hitTime };
    return true;
}
function outcome(fighter, mob, roll, { boss = false, requiredMark = null, at = Infinity } = {}) {
    const rule = Native.catalog.npcs[mob.selfId], stats = fighter.state.stats;
    if (!rule || !stats?.soulCrystalQuest || fighter.vitals.hp <= 0 || boss && stats.soulCrystalGoal) return null;
    const item = single(fighter.state);
    if (!item || stats.soulCrystalGoal && !BotCrystal.canAdvance(fighter.state, stats.soulCrystalGoal, item.selfId)) return null;
    const mark = requiredMark || fighter.soulCrystalMark;
    if (!boss && ( !mark || Number(mark.completeAt || 0) > at || mark.objectId !== item.id || mark.fromId !== item.selfId)) return null;
    const metadata = Native.catalog.crystals[item.selfId];
    // Ineligible solo kills do not spend a draw from the reward stream.
    // Numeric callers (including the existing shared party roll) keep their value.
    const draw = typeof roll === 'function' ? roll() : roll;
    const result = Native.outcomeFor(rule, metadata.stage, mob.selfId, draw);
    if (result === 'refused' || result === 'failed') return null;
    const toId = result === 'success' ? metadata.nextId : metadata.brokenId;
    const change = { ...mark, objectId: item.id, fromId: item.selfId, toId, npcId: mob.selfId,
        roll: draw, skillId: 2096, boss };
    const inventory = { ...fighter.state.inventory };
    applyInventoryStep(inventory, change);
    fighter.state.inventory = inventory;
    fighter.soulCrystals ||= []; fighter.soulCrystals.push(change);
    return change;
}
module.exports = { single, tryCast, outcome, applyInventoryStep };
