const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText = invoke('GameServer/ConsoleText');
const EnchantRules = invoke('GameServer/Items/C4EnchantRules');
const ToggleSkills = invoke('GameServer/Skills/ToggleSkills');

function send(session, packet) {
    session?.dataSendToMe?.(packet);
}

function sendFailure(session) {
    send(session, ServerResponse.enchantResult(2));
}

function sendSuccessMessage(session, item, oldLevel) {
    if (oldLevel > 0) {
        ConsoleText.transmit(session, 63, [
            { kind: ConsoleText.kind.number, value: oldLevel },
            { kind: ConsoleText.kind.item, value: item.fetchSelfId() }
        ]);
    } else {
        ConsoleText.transmit(session, 62, [
            { kind: ConsoleText.kind.item, value: item.fetchSelfId() }
        ]);
    }
}

function sendBreakMessage(session, item, oldLevel) {
    ConsoleText.transmit(session, oldLevel > 0 ? 65 : 64, oldLevel > 0
        ? [
            { kind: ConsoleText.kind.number, value: oldLevel },
            { kind: ConsoleText.kind.item, value: item.fetchSelfId() }
        ]
        : [{ kind: ConsoleText.kind.item, value: item.fetchSelfId() }]);
}

function crystalTemplate(selfId) {
    return DataCache.items?.find((entry) => Number(entry.selfId) === Number(selfId));
}

function removeFromMemory(backpack, item) {
    if (item.fetchEquipped?.()) {
        backpack.unequipPaperdoll(item.fetchSlot());
        item.setEquipped(false);
    }
    backpack.items = backpack.fetchItems().filter((entry) => entry.fetchId() !== item.fetchId());
}

function updateScrollMemory(backpack, scroll, amount) {
    if (amount > 0) {
        scroll.setAmount(amount);
    } else {
        backpack.items = backpack.fetchItems().filter((entry) => entry.fetchId() !== scroll.fetchId());
    }
}

function updateCrystalMemory(backpack, result) {
    const existing = backpack.fetchItemRaw(result.crystalItemId)
        || backpack.fetchItemFromSelfId(result.crystalId);
    if (existing) {
        existing.setAmount(result.crystalTotal);
        return;
    }
    backpack.insertItem(result.crystalItemId, result.crystalId, {
        amount: result.crystalTotal,
        equipped: false,
        slot: 0,
        enchant: 0
    });
}

function refresh(session) {
    const actor = session.actor;
    send(session, ServerResponse.itemsList(actor.backpack.fetchItems()));
    try {
        ToggleSkills.syncEquipment(session, actor);
    } catch (error) {
        utils.infoWarn('Enchant', 'failed to sync toggles for %s: %s', actor.fetchName?.() || actor.fetchId?.(), error.message);
    }
    try {
        send(session, ServerResponse.userInfo(actor));
        session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
    } catch (error) {
        utils.infoWarn('Enchant', 'failed to refresh user info for %s: %s', actor.fetchName?.() || actor.fetchId?.(), error.message);
    }
}

function configFor(options = {}) {
    return EnchantRules.configWith({
        ...(globalThis.options?.default?.Enchant || {}),
        ...(options.config || {}),
        ...options
    });
}

async function enchant(session, objectId, options = {}) {
    const actor = session?.actor;
    const backpack = actor?.backpack;
    const active = session?.activeEnchantItem;
    const scroll = active ? backpack?.fetchItemRaw?.(active.itemId) : null;
    const target = backpack?.fetchItemRaw?.(objectId);
    const scrollRule = EnchantRules.resolveScroll(scroll?.fetchSelfId?.() || active?.selfId);
    const config = configFor(options);
    const finish = () => { if (session) session.activeEnchantItem = null; };

    if (!actor || !backpack || !active || !scroll || !target || !scrollRule
        || Number(scroll.fetchSelfId()) !== Number(active.selfId)
        || scroll.fetchAmount() < 1
        || actor.isDead?.()
        || Number(actor.fetchPrivateStoreType?.() || 0) !== 0
        || actor.state?.fetchCasts?.()
        || actor.state?.fetchHits?.()
        || !EnchantRules.validTarget(target, scrollRule)) {
        finish();
        sendFailure(session);
        return { ok: false, result: 'invalid' };
    }

    const category = EnchantRules.categoryOf(target);
    const oldLevel = EnchantRules.enchantLevelOf(target);
    const max = EnchantRules.maxFor(category, config);
    if (max > 0 && oldLevel >= max) {
        finish();
        sendFailure(session);
        return { ok: false, result: 'invalid' };
    }

    const chance = EnchantRules.isSafe(target, oldLevel, config)
        ? 100
        : EnchantRules.chanceFor(category, scrollRule.scrollType, config);
    const random = typeof options.rng === 'function' ? options.rng : Math.random;
    const success = (Number(random()) * 100) < chance;
    const result = success ? 'success' : (scrollRule.scrollType === 'blessed' ? 'blessed-fail' : 'break');
    const nextLevel = success ? oldLevel + 1 : (result === 'blessed-fail' ? 0 : oldLevel);
    const crystalId = EnchantRules.CRYSTAL_IDS[EnchantRules.gradeOf(target)];
    const crystalAmount = result === 'break'
        ? Math.max(1, EnchantRules.crystalCount(target, oldLevel) - Math.floor((Number(target.fetchCristals?.() || 0) + 1) / 2))
        : 0;
    const crystal = crystalTemplate(crystalId);

    try {
        const persisted = await Database.enchantInventoryItem(actor.fetchId(), {
            scrollId: scroll.fetchId(),
            scrollSelfId: scroll.fetchSelfId(),
            targetId: target.fetchId(),
            targetSelfId: target.fetchSelfId(),
            expectedEnchant: oldLevel,
            result,
            enchantLevel: nextLevel,
            crystalId,
            crystalName: crystal?.template?.name || '',
            crystalAmount
        });

        updateScrollMemory(backpack, scroll, persisted.scrollAmount);
        if (result === 'success') {
            target.setEnchantLevel(nextLevel);
            sendSuccessMessage(session, target, oldLevel);
            send(session, ServerResponse.enchantResult(0));
        } else if (result === 'blessed-fail') {
            target.setEnchantLevel(0);
            ConsoleText.transmit(session, 1517);
            send(session, ServerResponse.enchantResult(2));
        } else {
            sendBreakMessage(session, target, oldLevel);
            removeFromMemory(backpack, target);
            ConsoleText.transmit(session, ConsoleText.caption.earnedAmountOf, [
                { kind: ConsoleText.kind.item, value: crystalId },
                { kind: ConsoleText.kind.number, value: crystalAmount }
            ]);
            updateCrystalMemory(backpack, persisted);
            send(session, ServerResponse.enchantResult(1));
        }

        try {
            invoke(path.actor).calculateStats(session, actor);
        } catch (error) {
            utils.infoWarn('Enchant', 'failed to recalculate stats for %s: %s', actor.fetchName?.() || actor.fetchId?.(), error.message);
        }
        refresh(session);
        finish();
        return { ok: true, result, enchant: nextLevel, crystalAmount };
    } catch (error) {
        utils.infoWarn('Enchant', 'failed for %s: %s', actor.fetchName?.() || actor.fetchId?.(), error.message);
        finish();
        sendFailure(session);
        return { ok: false, result: 'error', error };
    }
}

module.exports = { enchant };
