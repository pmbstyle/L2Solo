'use strict';

const data = require('../../../data/Skills/c4-skill-books.json');
const ClassProgression = require('../ClassProgression');
const books = new Map(data.skills);
const bookIds = new Set(books.values());
let treeSource = null;
let indexed = new Map();
let definitionSource = null;
let definedRanks = new Map();
// Static first-rank attack ids only, bounded by the native spellbook catalogue
// (275 ids). Replaced with the skill-definition source; no per-bot state.
let valued = new Set();

function ranksFor(skillId) {
    const definitions = invoke('GameServer/DataCache').skills || [];
    if (definitions !== definitionSource) {
        definitionSource = definitions;
        definedRanks = new Map(definitions.map((skill) => [Number(skill.selfId),
            new Set((skill.levels || []).map((rank) => Number(rank.level)))]));
        const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
        valued = new Set(Profile.skillSnapshotsFromRecords([...books.keys()].map(selfId => ({ selfId, level: 1 })))
            .filter(Profile.isAttackSkill).map(skill => Number(skill.selfId)));
    }
    return definedRanks.get(Number(skillId));
}

function entries(classId) {
    const trees = invoke('GameServer/DataCache').skillTree || [];
    if (trees !== treeSource) { treeSource = trees; indexed = new Map(); }
    if (!indexed.has(Number(classId))) {
        const skills = new Map();
        for (const ancestor of ClassProgression.lineage(classId)) {
            for (const entry of trees.find((row) => Number(row.classId) === ancestor)?.skills || []) {
                const held = skills.get(Number(entry.selfId)) || { ...entry, levels: [] };
                const ranks = new Map(held.levels.map((row) => [Number(row.level), row]));
                for (const row of entry.levels || []) ranks.set(Number(row.level), row);
                skills.set(Number(entry.selfId), { ...entry, levels: [...ranks.values()].sort((a, b) => a.level - b.level) });
            }
        }
        indexed.set(Number(classId), [...skills.values()]);
    }
    return indexed.get(Number(classId));
}

function nextTraining(classId, characterLevel, skillId, learnedLevel = 0) {
    const entry = entries(classId).find((row) => Number(row.selfId) === Number(skillId));
    const defined = ranksFor(skillId);
    const rank = entry?.levels.find((row) => Number(row.level) > Number(learnedLevel) && defined?.has(Number(row.level)));
    if (!rank || Number(rank.pLevel) > Number(characterLevel)) return null;
    return { skillId: Number(skillId), name: entry.name, level: Number(rank.level),
        sp: Math.max(0, Number(rank.sp) || 0), bookId: Number(learnedLevel) === 0 && valued.has(Number(skillId))
            ? books.get(Number(skillId)) || null : null };
}

function learned(state) {
    return new Map((state.stats?.coldCombat?.skills || state.skills || [])
        .map((row) => [Number(row.selfId), Number(row.level)]));
}

function requiredBooks(state = {}) {
    const known = learned(state);
    const classId = Number(state.stats?.classId ?? state.classId);
    return entries(classId).flatMap((entry) => {
        const training = nextTraining(classId, state.level, entry.selfId, known.get(Number(entry.selfId)) || 0);
        if (!training?.bookId) return [];
        return [{ selfId: training.bookId, skillId: training.skillId, level: training.level, sp: training.sp }];
    });
}

function missingBooks(state = {}) {
    return requiredBooks(state).filter((book) => Number(state.inventory?.[book.selfId]?.amount || 0) <= 0);
}

function needsTraining(state = {}) {
    const known = learned(state);
    const classId = Number(state.stats?.classId ?? state.classId);
    return entries(classId).some((entry) => {
        const training = nextTraining(classId, state.level, entry.selfId, known.get(Number(entry.selfId)) || 0);
        return training && Number(state.sp || 0) >= training.sp
            && (!training.bookId || Number(state.inventory?.[training.bookId]?.amount || 0) > 0);
    });
}

function nextTrainingSp(state = {}) {
    const known = learned(state), classId = Number(state.stats?.classId ?? state.classId);
    let next = Infinity;
    for (const entry of entries(classId)) {
        const training = nextTraining(classId, state.level, entry.selfId, known.get(Number(entry.selfId)) || 0);
        if (training && (training.bookId === null || Number(state.inventory?.[training.bookId]?.amount || 0) > 0)) {
            next = Math.min(next, training.sp);
        }
    }
    return next;
}

// Native training pays from the committed balance. Apply its exact delta to
// an incoming cold resolve, which can also contain newly earned SP or books.
function applyTraining(state, result = {}) {
    const inventory = { ...(state.inventory || {}) };
    for (const book of result.consumedBooks || []) {
        const item = inventory[book.selfId];
        if (!item) continue;
        const amount = Math.max(0, Number(item.amount || 0) - Number(book.amount || 0));
        if (amount) inventory[book.selfId] = { ...item, amount,
            ...(item.instances ? { instances: item.instances.flatMap(row => Number(row.id) !== Number(book.objectId)
                ? [row] : book.remaining > 0 ? [{ ...row, amount: book.remaining }] : []) } : {}) };
        else delete inventory[book.selfId];
    }
    return { ...state, sp: Math.max(0, Number(state.sp || 0) - Number(result.spentSp || 0)), inventory };
}

function applyActor(session, result = {}) {
    const actor = session?.actor;
    if (!actor) return;
    actor.setSp(Math.max(0, Number(actor.fetchSp()) - Number(result.spentSp || 0)));
    for (const book of result.consumedBooks || []) {
        const item = actor.backpack.fetchItemRaw(book.objectId);
        if (item) item.setAmount(Math.max(0, Number(item.fetchAmount()) - book.amount));
    }
    actor.backpack.items = actor.backpack.fetchItems().filter((item) => Number(item.fetchAmount()) > 0);
    invoke('GameServer/Item/Item').bindInventory(actor.backpack);
}

module.exports = { entries, nextTraining, requiredBooks, missingBooks, needsTraining, nextTrainingSp, applyTraining, applyActor,
    bookFor: (skillId) => books.get(Number(skillId)) || null, isBook: (itemId) => bookIds.has(Number(itemId)) };
