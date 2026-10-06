'use strict';

const Catalog = require('../Skills/SkillBookCatalog');
const pending = new WeakMap();

function stateFor(actor) {
    const inventory = {};
    for (const item of actor.backpack?.fetchItems?.() || []) {
        const selfId = Number(item.fetchSelfId());
        inventory[selfId] = { amount: Number(inventory[selfId]?.amount || 0) + Number(item.fetchAmount()) };
    }
    return { level: actor.fetchLevel(), sp: actor.fetchSp(), inventory, stats: { classId: actor.fetchClassId(),
        coldCombat: { skills: (actor.skillset?.fetchSkills?.() || []).map((skill) => ({
            selfId: skill.fetchSelfId(), level: skill.fetchLevel() })) } } };
}

function review(session) {
    const actor = session?.actor;
    if (!actor || !String(session.accountId || '').startsWith('bot_')) return Promise.resolve(null);
    if (pending.has(actor)) return pending.get(actor);
    const Progression = invoke('GameServer/Bot/BotClassProgression');
    const state = stateFor(actor);
    if (!Catalog.needsTraining(state) && !Progression.plan({ classId: actor.fetchClassId(), level: actor.fetchLevel(),
        seed: actor.fetchId() }).transitions.length) return Promise.resolve(null);
    const work = Progression.reconcile({ characterId: actor.fetchId(), classId: actor.fetchClassId(),
        level: actor.fetchLevel(), seed: actor.fetchId() }, { beforeWrite() {
        if (session.actor !== actor || session.populationStaging) throw new Error('bot_training_actor_retired');
    }, onTrained(result) {
        // Reflect each committed cost before another rank flushes hot writes.
        // XP earned during the await is retained in the current actor balance.
        Catalog.applyActor(session, result);
        invoke('GameServer/Persistence/CharacterWriteQueue').experience(actor.fetchId(), actor.fetchLevel(),
            actor.fetchExp(), actor.fetchSp());
    } }).then(async (result) => {
        if (session.actor !== actor) return result;
        if (Number(result.classId) !== Number(actor.fetchClassId())) actor.setClassId(result.classId);
        if (result.learnedCount || result.transitions.length) {
            await actor.skillset.populate(actor.fetchId());
            invoke(path.actor).calculateStats(session, actor);
        }
        return result;
    }).finally(() => pending.delete(actor));
    pending.set(actor, work);
    return work;
}

module.exports = { review, stateFor };
