const ServerResponse = invoke('GameServer/Network/Response');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const ARMOR_SLOTS = {
    earringRight: 1,
    earringLeft: 2,
    necklace: 3,
    ringRight: 4,
    ringLeft: 5,
    head: 6,
    weapon: 7,
    shield: 8,
    hands: 9,
    chest: 10,
    pants: 11,
    feet: 12,
    dual: 14,
    fullArmor: 15
};

const RANK_ORDER = ['none', 'd', 'c', 'b', 'a', 's'];
const UPGRADE_COOLDOWN_MS = 5000;

function isBotSession(session) {
    return !!session && (
        session.constructor.name === 'BotSession' ||
        String(session.accountId || '').startsWith('bot_')
    );
}

function gradeForLevel(level) {
    const value = Number(level || 1);
    if (value >= 76) return 's';
    if (value >= 61) return 'a';
    if (value >= 52) return 'b';
    if (value >= 40) return 'c';
    if (value >= 20) return 'd';
    return 'none';
}

function rankAllowed(item, actor) {
    const itemRank = item.fetchRank ? item.fetchRank() : 'none';
    const itemIndex = RANK_ORDER.indexOf(itemRank);
    const actorIndex = RANK_ORDER.indexOf(gradeForLevel(actor.fetchLevel()));
    if (itemIndex < 0 || actorIndex < 0) return false;
    return itemIndex <= actorIndex;
}

function armorStyleFor(role) {
    if (role === 'mage' || role === 'healer' || role === 'buffer') return 'robe';
    if (role === 'archer' || role === 'dagger') return 'light';
    return 'heavy';
}

function weaponKindsFor(role, classId) {
    if (role === 'archer') return ['Weapon.Bow'];
    if (role === 'dagger') return ['Weapon.Knife'];
    if (role === 'mage' || role === 'healer' || role === 'buffer') {
        return ['Weapon.Sword', 'Weapon.Blunt'];
    }
    if ([44, 45, 47, 49, 50, 51, 53, 54, 56].includes(Number(classId))) {
        return ['Weapon.Blunt'];
    }
    return ['Weapon.Sword', 'Weapon.Blunt'];
}

function armorKindsFor(role, slot) {
    const style = armorStyleFor(role);
    if ([ARMOR_SLOTS.chest, ARMOR_SLOTS.pants, ARMOR_SLOTS.fullArmor].includes(Number(slot))) {
        if (style === 'robe') return ['Armor.Fabric'];
        if (style === 'light') return ['Armor.Leather'];
        return ['Armor.Chain'];
    }
    if ([ARMOR_SLOTS.head, ARMOR_SLOTS.hands, ARMOR_SLOTS.feet].includes(Number(slot))) {
        return ['Armor.Wear'];
    }
    if ([ARMOR_SLOTS.earringRight, ARMOR_SLOTS.earringLeft, ARMOR_SLOTS.necklace, ARMOR_SLOTS.ringRight, ARMOR_SLOTS.ringLeft].includes(Number(slot))) {
        return ['Armor.Jewel'];
    }
    if (Number(slot) === ARMOR_SLOTS.shield) return ['Armor.Shield'];
    return [];
}

function isUnsafeFullBodyRobe(role, item, slot) {
    return ['mage', 'healer', 'buffer'].includes(role) &&
        Number(slot) === ARMOR_SLOTS.fullArmor &&
        item.fetchKind() === 'Armor.Fabric' &&
        item.fetchRank?.() === 'none';
}

function isSuitableItem(actor, item) {
    if (!item?.isWearable?.() || item.fetchEquipped?.()) return false;
    if (!rankAllowed(item, actor)) return false;
    if (item.fetchPrice?.() <= 0) return false;

    const role = BotRoles.inferRole(actor);
    const kind = item.fetchKind();
    const slot = Number(item.fetchSlot());

    if (item.isWeapon()) {
        const kinds = weaponKindsFor(role, actor.fetchClassId());
        if (!kinds.includes(kind)) return false;
        if (!['mage', 'healer', 'buffer', 'archer'].includes(role) && slot !== ARMOR_SLOTS.weapon) return false;
        return true;
    }

    if (item.isArmor()) {
        if (slot === ARMOR_SLOTS.shield && ['mage', 'healer', 'buffer', 'archer', 'dagger'].includes(role)) return false;
        if (isUnsafeFullBodyRobe(role, item, slot)) return false;
        return armorKindsFor(role, slot).includes(kind);
    }

    return false;
}

function scoreItem(actor, item) {
    const role = BotRoles.inferRole(actor);
    const kind = item.fetchKind();
    const slot = Number(item.fetchSlot());

    if (item.isWeapon()) {
        if (role === 'mage' || role === 'healer' || role === 'buffer') {
            return item.fetchMAtk() * 3 + item.fetchPAtk();
        }
        return item.fetchPAtk() * 2 + item.fetchMAtk();
    }

    if (kind === 'Armor.Jewel') return item.fetchMDef();
    if (slot === ARMOR_SLOTS.shield) return item.fetchPDef();
    return item.fetchPDef() + item.fetchBonusMp();
}

function currentItemForSlot(backpack, slot) {
    if (!backpack) return null;
    if (slot === ARMOR_SLOTS.weapon || slot === ARMOR_SLOTS.dual) {
        return backpack.fetchEquippedWeapon ? backpack.fetchEquippedWeapon() : null;
    }
    return backpack.fetchItemRaw(backpack.fetchPaperdollId(slot));
}

function currentScoreForSlot(actor, slot) {
    const backpack = actor.backpack;
    if (!backpack) return 0;

    if (slot === ARMOR_SLOTS.fullArmor) {
        const full = currentItemForSlot(backpack, ARMOR_SLOTS.fullArmor);
        if (full) return scoreItem(actor, full);
        const chest = currentItemForSlot(backpack, ARMOR_SLOTS.chest);
        const pants = currentItemForSlot(backpack, ARMOR_SLOTS.pants);
        return (chest ? scoreItem(actor, chest) : 0) + (pants ? scoreItem(actor, pants) : 0);
    }

    const current = currentItemForSlot(backpack, slot);
    return current ? scoreItem(actor, current) : 0;
}

function candidateSlots(item) {
    const slot = Number(item.fetchSlot());
    if (slot === ARMOR_SLOTS.earringRight || slot === ARMOR_SLOTS.earringLeft) {
        return [ARMOR_SLOTS.earringRight, ARMOR_SLOTS.earringLeft];
    }
    if (slot === ARMOR_SLOTS.ringRight || slot === ARMOR_SLOTS.ringLeft) {
        return [ARMOR_SLOTS.ringRight, ARMOR_SLOTS.ringLeft];
    }
    return [slot];
}

function bestUpgradeSlot(actor, item, plannedScores) {
    const itemScore = scoreItem(actor, item);
    if (itemScore <= 0) return null;

    return candidateSlots(item).reduce((best, slot) => {
        const currentScore = plannedScores.get(slot) ?? currentScoreForSlot(actor, slot);
        if (itemScore <= currentScore) return best;
        if (!best) return { slot, currentScore };
        return currentScore < best.currentScore ? { slot, currentScore } : best;
    }, null)?.slot || null;
}

function findBestUpgrades(session) {
    const actor = session?.actor;
    const items = actor?.backpack?.fetchItems ? actor.backpack.fetchItems() : [];
    const plannedScores = new Map();
    const usedIds = new Set();

    return items
        .filter((item) => isSuitableItem(actor, item))
        .sort((a, b) => scoreItem(actor, b) - scoreItem(actor, a) || b.fetchPrice() - a.fetchPrice())
        .reduce((upgrades, item) => {
            if (usedIds.has(item.fetchId())) return upgrades;

            const slot = bestUpgradeSlot(actor, item, plannedScores);
            if (!slot) return upgrades;

            const itemScore = scoreItem(actor, item);
            usedIds.add(item.fetchId());
            plannedScores.set(slot, itemScore);

            if (slot === ARMOR_SLOTS.fullArmor) {
                plannedScores.set(ARMOR_SLOTS.chest, itemScore);
                plannedScores.set(ARMOR_SLOTS.pants, itemScore);
            }

            upgrades.push({ item, slot, score: itemScore });
            return upgrades;
        }, []);
}

function canApplyNow(session, options = {}) {
    if (!options.force && !isBotSession(session)) return false;
    const actor = session?.actor;
    if (!actor?.backpack || actor.isDead?.()) return false;
    if (actor.state?.fetchHits?.() || actor.state?.fetchCasts?.() || actor.state?.fetchTowards?.()) return false;
    if (!options.force && session.lastEquipmentUpgradeCheckAt && Date.now() - session.lastEquipmentUpgradeCheckAt < UPGRADE_COOLDOWN_MS) return false;
    return true;
}

function applyBestUpgrades(session, options = {}) {
    if (!canApplyNow(session, options)) return [];

    const actor = session.actor;
    session.lastEquipmentUpgradeCheckAt = Date.now();
    const upgrades = findBestUpgrades(session);
    if (upgrades.length === 0) return [];

    upgrades.forEach(({ item, slot }) => {
        if (Number(item.fetchSlot()) !== Number(slot)) {
            item.setSlot(slot);
        }
        if ([ARMOR_SLOTS.earringRight, ARMOR_SLOTS.ringRight].includes(Number(slot)) && actor.backpack.fetchPaperdollId(slot)) {
            actor.backpack.unequipGear(session, slot);
            item.setSlot(slot);
        }
        actor.backpack.equipGear(session, item);
    });

    session.lastEquipmentUpgradeAt = Date.now();

    if (session.dataSendToOthers) {
        session.dataSendToOthers(ServerResponse.charInfo(actor), actor);
    }
    if (session.dataSendToMe) {
        session.dataSendToMe(ServerResponse.itemsList(actor.backpack.fetchItems()));
    }

    console.info(
        "BotGear :: %s equipped upgrades: %s",
        actor.fetchName(),
        upgrades.map(({ item }) => item.fetchName()).join(', ')
    );

    return upgrades;
}

module.exports = {
    applyBestUpgrades,
    findBestUpgrades,
    scoreItem
};
