const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const RoundLoot = require('./RoundLoot');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

const WEAPON_SLOTS = new Set([7, 14]);
const ARMOR_SLOTS = new Set([6, 8, 9, 10, 11, 12, 15]);
const JEWEL_SLOTS = new Set([1, 2, 3, 4, 5]);

function templateFor(item = {}) {
    return ItemTemplateIndex.find(DataCache.items, item.selfId) || null;
}

function equipmentDrop(item = {}) {
    const kind = item.kind || templateFor(item)?.template?.kind || '';
    return String(kind).startsWith('Weapon.') || String(kind).startsWith('Armor.');
}

function inventoryTemplates(inventory = {}) {
    return Object.values(inventory || {}).flatMap((item) => {
        if (Number(item?.amount || 0) < 1) return [];
        const template = templateFor(item);
        return template ? [template] : [];
    });
}

function slotPriority(item = {}) {
    const slot = Number(item.etc?.slot || 0);
    if (WEAPON_SLOTS.has(slot)) return 8;
    if (ARMOR_SLOTS.has(slot)) return 4;
    return JEWEL_SLOTS.has(slot) ? 1 : 0;
}

function projectedInventory(state = {}, projected = new Map()) {
    return projected.get(Number(state.characterId)) || { ...(state.inventory || {}) };
}

function recipientScore(state, item, projected) {
    const template = templateFor(item);
    if (!template || !equipmentDrop(item)) return -Infinity;
    const role = GearAcquisitionPlanner.roleFor(state);
    const classId = Number(state.stats?.classId ?? state.classId ?? 0);
    if (!GearAcquisitionPlanner.suitable(template, state, role)) return -Infinity;

    const inventory = projectedInventory(state, projected);
    const owned = inventoryTemplates(inventory);
    if (!GearAcquisitionPlanner.isSlotUpgrade(template, owned, role, classId)) return -Infinity;

    const targetId = Number(state.stats?.equipmentPlan?.target?.selfId || 0);
    const targetBonus = Number(template.selfId) === targetId ? 100000 : 0;
    const current = owned
        .filter((ownedItem) => (
            (WEAPON_SLOTS.has(Number(ownedItem.etc?.slot || 0)) ? 'weapon' : Number(ownedItem.etc?.slot || 0))
            === (WEAPON_SLOTS.has(Number(template.etc?.slot || 0)) ? 'weapon' : Number(template.etc?.slot || 0))
        ))
        .reduce((best, ownedItem) => Math.max(best, GearAcquisitionPlanner.itemScore(ownedItem, role, classId)), 0);
    const improvement = Math.max(1, GearAcquisitionPlanner.itemScore(template, role, classId) - current + 2);
    const fairness = -Number(state.stats?.partyGearReceived || 0) * 0.01;
    return targetBonus + slotPriority(template) * improvement + fairness;
}

// The member's projected bag with the drop added (RoundLoot.addTo, the one bag-add rule).
function addProjectedItem(state, item, projected) {
    projected.set(Number(state.characterId), RoundLoot.addTo(projectedInventory(state, projected), [item]));
}

// A party with no agreement: each member keeps its own drops (C4 finders keepers:
// L2PcInstance.doPickupItem checks the picker's own capacity), a drop its bag does not
// take (takes(state, bag, item), the C4 pickup rule on bags[index], its running bag;
// none: its state's) stays on the ground (refused: how many), and a gear drop passes
// to the member it upgrades most among those whose bag takes it.
function transferGearDrops(memberResults = [], { bags = [], takes = () => true } = {}) {
    const copies = memberResults.map((entry) => ({
        ...entry,
        result: {
            ...entry.result,
            patch: { ...(entry.result?.patch || {}) },
            materialize: {
                ...(entry.result?.materialize || {}),
                items: [...(entry.result?.materialize?.items || [])]
            }
        }
    }));
    const projected = new Map(copies.map(({ state }, index) => [Number(state.characterId), { ...(bags[index] || state.inventory || {}) }]));
    const fits = (state, item) => takes(state, projected.get(Number(state.characterId)), item);
    const transfers = [];
    let refused = 0;

    const originalDrops = copies.flatMap((source) => (
        source.result.materialize.items.map((item) => ({ source, item }))
    ));
    originalDrops.forEach(({ source, item }) => {
        const sourceItems = source.result.materialize.items;
        const recipient = equipmentDrop(item) ? copies
            .map((entry) => ({ entry, score: recipientScore(entry.state, item, projected) }))
            .filter((candidate) => Number.isFinite(candidate.score) && fits(candidate.entry.state, item))
            .sort((left, right) => right.score - left.score
                || Number(left.entry.state.characterId) - Number(right.entry.state.characterId))[0]?.entry : null;
        if (!recipient) {
            if (fits(source.state, item)) addProjectedItem(source.state, item, projected);
            else {
                const at = sourceItems.indexOf(item);
                if (at >= 0) sourceItems.splice(at, 1);
                refused += 1;
            }
            return;
        }

        addProjectedItem(recipient.state, item, projected);
        if (Number(recipient.state.characterId) === Number(source.state.characterId)) return;
        const index = sourceItems.indexOf(item);
        if (index >= 0) sourceItems.splice(index, 1);
        recipient.result.materialize.items.push(item);
        recipient.result.patch.stats = {
            ...(recipient.result.patch.stats || {}),
            partyGearReceived: Number(recipient.result.patch.stats?.partyGearReceived ?? recipient.state.stats?.partyGearReceived ?? 0) + 1
        };
        transfers.push({
            from: source.state,
            to: recipient.state,
            item
        });
    });

    return { memberResults: copies, transfers, refused };
}

module.exports = { equipmentDrop, recipientScore, transferGearDrops };
