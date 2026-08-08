const World = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DataCache = invoke('GameServer/DataCache');
const { marketStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');
const PARTY_WITHDRAWAL_WAIT_MS = 10000;
const PARTY_WITHDRAWAL_POLL_MS = 10;

function itemName(selfId) {
    return (DataCache.items || []).find((entry) => Number(entry.selfId) === Number(selfId))?.template?.name
        || `Item ${selfId}`;
}

function storeFor(session) {
    const store = session?.actor?.fetchPrivateStore?.();
    return session?.plan === 'merchant' && store?.storeType === 1 && Array.isArray(store.items)
        ? store
        : null;
}

function revision(store) {
    return Math.max(1, Math.floor(Number(store?.revision) || 1));
}

function lineFor(store, identifier) {
    const id = Number(identifier);
    if (!store || !Number.isInteger(id) || id <= 0) return null;
    return store.items.find((line) => Number(line.selfId) === id || Number(line.objectId) === id) || null;
}

function compactLine(line) {
    if (!line) return null;
    return {
        selfId: Number(line.selfId),
        name: line.name || itemName(line.selfId),
        count: Math.max(0, Number(line.count || 0)),
        unitPrice: Math.max(1, Number(line.price || 0))
    };
}

function invalidateCustomerWindows(merchantActor) {
    let invalidated = 0;
    (World.user?.sessions || []).forEach((viewer) => {
        if (viewer?.activeMerchantTrade?.merchant !== merchantActor) return;
        viewer.activeMerchantTrade = null;
        viewer.viewedPrivateStoreSeller = null;
        viewer.dataSendToMe?.(ServerResponse.actionFailed());
        invalidated += 1;
    });
    return invalidated;
}

function applyClosed(actor) {
    actor.setPrivateStoreType(0);
    actor.setPrivateStore?.({ storeType: 0, title: '', items: [] });
    actor.state?.setSeated?.(false);
}

function notifyClosed(session, actor) {
    session.dataSendToOthers?.(ServerResponse.sitAndStand(actor), actor);
    session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
}

function applyOpened(actor, store) {
    actor.setPrivateStore(store);
    actor.setPrivateStoreType(1);
    actor.state?.setSeated?.(true);
}

function notifyOpened(session, actor, store) {
    session.dataSendToOthers?.(ServerResponse.sitAndStand(actor), actor);
    session.dataSendToOthers?.(ServerResponse.charInfo(actor), actor);
    session.dataSendToOthers?.(ServerResponse.privateStoreMsg(actor, store.title), actor);
}

function safelyNotify(label, work) {
    try {
        work();
        return null;
    } catch (error) {
        const message = error?.message || String(error);
        utils.infoWarn('BotMerchant', '%s broadcast failed: %s', label, message);
        return message;
    }
}

function persistedState(session, store) {
    const current = session.coldMarketState;
    const marketStore = current?.stats?.marketStore;
    if (!current || !marketStore) return null;
    return {
        ...current,
        stats: {
            ...(current.stats || {}),
            marketStore: {
                ...marketStore,
                title: store.title,
                revision: store.revision,
                items: store.items.map((line) => {
                    const persisted = (marketStore.items || []).find((item) => Number(item.selfId) === Number(line.selfId)) || {};
                    return {
                        ...persisted,
                        selfId: Number(line.selfId),
                        name: line.name || itemName(line.selfId),
                        count: Number(line.count),
                        price: Number(line.price),
                        rank: line.rank || persisted.rank || 'none'
                    };
                })
            },
            lastNegotiatedStoreUpdate: {
                revision: store.revision,
                at: Date.now()
            }
        }
    };
}

async function applyLifecycle(session, nextState, reason = 'merchant_market_maintenance') {
    const actor = session?.actor;
    const current = storeFor(session);
    if (!actor || !current || !nextState) return { ok: false, reason: 'merchant_store_unavailable' };
    if (current.repricing === true || Number(current.activePurchases || 0) > 0) {
        return { ok: false, reason: 'store_busy' };
    }

    const stateStore = nextState.stats?.marketStore || null;
    const previous = current;
    const nextStore = stateStore ? {
        ...previous,
        ...stateStore,
        repricing: false,
        activePurchases: 0,
        revision: revision(previous) + 1,
        title: stateStore.autoTitle === false ? stateStore.title : marketStoreTitle(stateStore.items),
        items: (stateStore.items || []).map((item) => ({ ...item }))
    } : null;

    previous.repricing = true;
    session.merchantStoreMutation = true;
    const invalidatedWindows = invalidateCustomerWindows(actor);
    applyClosed(actor);
    const closeBroadcastWarning = safelyNotify('close', () => notifyClosed(session, actor));

    let saved;
    try {
        const stateToSave = nextStore ? {
            ...nextState,
            stats: {
                ...(nextState.stats || {}),
                marketStore: {
                    ...stateStore,
                    revision: nextStore.revision,
                    title: nextStore.title,
                    items: nextStore.items.map((item) => ({ ...item }))
                }
            }
        } : nextState;
        saved = await LifeState.upsertState(stateToSave, reason);
        if (!saved) throw new Error('state_save_failed');
    } catch (error) {
        restore(session, actor, previous);
        session.merchantStoreMutation = false;
        return { ok: false, reason: 'store_persist_failed', error: error.message || String(error) };
    }

    session.coldMarketState = saved;
    if (!nextStore) {
        session.plan = 'shopping';
        session.merchantStoreMutation = false;
        return {
            ok: true,
            reason: 'store_closed',
            state: saved,
            invalidatedWindows,
            broadcastWarning: closeBroadcastWarning
        };
    }

    applyOpened(actor, nextStore);
    session.merchantStoreMutation = false;
    const openBroadcastWarning = safelyNotify('open', () => notifyOpened(session, actor, nextStore));
    return {
        ok: true,
        reason: 'store_reopened',
        state: saved,
        store: nextStore,
        invalidatedWindows,
        broadcastWarning: openBroadcastWarning || closeBroadcastWarning
    };
}

function restore(session, actor, store) {
    store.repricing = false;
    applyOpened(actor, store);
    safelyNotify('restore', () => notifyOpened(session, actor, store));
}

async function republish(session, agreement) {
    const actor = session?.actor;
    const current = storeFor(session);
    if (!actor || !current) return { ok: false, reason: 'merchant_store_unavailable' };
    if (current.repricing === true) return { ok: false, reason: 'store_repricing' };
    const persistedStoreId = String(session.coldMarketState?.stats?.marketStore?.id || '');
    if (!persistedStoreId || String(agreement.storeId || '') !== persistedStoreId) {
        return { ok: false, reason: 'store_changed' };
    }
    if (agreement.storeRevision && revision(current) !== Number(agreement.storeRevision)) {
        return { ok: false, reason: 'store_changed' };
    }

    const line = lineFor(current, agreement.itemSelfId);
    const quantity = Math.floor(Number(agreement.quantity));
    const unitPrice = Math.floor(Number(agreement.unitPrice));
    if (!line || quantity < 1 || quantity > Number(line.count || 0)) {
        return { ok: false, reason: 'listed_stock_changed' };
    }
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 1) {
        return { ok: false, reason: 'invalid_store_price' };
    }

    const inventoryItem = actor.backpack?.fetchItemFromSelfId?.(line.selfId);
    if (!inventoryItem || inventoryItem.fetchEquipped?.() || Number(inventoryItem.fetchAmount?.() || 0) < quantity) {
        return { ok: false, reason: 'listed_stock_changed' };
    }

    const previous = current;
    previous.repricing = true;
    if (Number(previous.activePurchases || 0) > 0) {
        previous.repricing = false;
        return { ok: false, reason: 'store_busy' };
    }
    session.merchantStoreMutation = true;
    const nextItems = previous.items.map((entry) => (
        entry === line
            ? { ...entry, name: entry.name || itemName(entry.selfId), count: quantity, price: unitPrice }
            : { ...entry, name: entry.name || itemName(entry.selfId) }
    ));
    const nextStore = {
        ...previous,
        repricing: false,
        activePurchases: 0,
        revision: revision(previous) + 1,
        items: nextItems,
        title: marketStoreTitle(nextItems)
    };

    const invalidatedWindows = invalidateCustomerWindows(actor);
    applyClosed(actor);
    const closeBroadcastWarning = safelyNotify('close', () => notifyClosed(session, actor));

    let saved;
    try {
        const nextState = persistedState(session, nextStore);
        if (!nextState) throw new Error('market_state_missing');
        saved = await LifeState.upsertState(nextState, 'merchant_negotiated_reprice');
        if (!saved) throw new Error('state_save_failed');
    } catch (error) {
        restore(session, actor, previous);
        session.merchantStoreMutation = false;
        return { ok: false, reason: 'store_persist_failed', error: error.message || String(error) };
    }

    session.coldMarketState = saved;
    applyOpened(actor, nextStore);
    session.merchantStoreMutation = false;
    const openBroadcastWarning = safelyNotify('open', () => notifyOpened(session, actor, nextStore));
    return {
        ok: true,
        reason: 'store_reopened',
        store: {
            revision: nextStore.revision,
            title: nextStore.title,
            item: compactLine(lineFor(nextStore, agreement.itemSelfId))
        },
        invalidatedWindows,
        broadcastWarning: openBroadcastWarning || closeBroadcastWarning
    };
}

function needsPartyWithdrawal(session) {
    const actor = session?.actor;
    if (!actor) return false;
    const liveStore = actor.fetchPrivateStore?.();
    const privateStoreType = Number(actor.fetchPrivateStoreType?.() || 0);
    const marketState = session.coldMarketState;
    const persistedStore = marketState?.stats?.marketStore;
    return session.plan === 'merchant' || privateStoreType !== 0 || !!liveStore || !!persistedStore;
}

function waitForWithdrawalLock(session, deadline = Date.now() + PARTY_WITHDRAWAL_WAIT_MS) {
    const actor = session?.actor;
    if (!actor) return Promise.resolve({ ok: false, reason: 'missing_actor' });

    const store = actor.fetchPrivateStore?.();
    if (session.merchantStoreMutation !== true && store?.repricing !== true) {
        if (!store) return Promise.resolve({ ok: true, store: null });
        store.repricing = true;
        if (Number(store.activePurchases || 0) === 0) {
            session.merchantStoreMutation = true;
            return Promise.resolve({ ok: true, store });
        }
        store.repricing = false;
    }

    if (Date.now() >= deadline) return Promise.resolve({ ok: false, reason: 'store_busy' });
    return new Promise((resolve) => setTimeout(resolve, PARTY_WITHDRAWAL_POLL_MS))
        .then(() => waitForWithdrawalLock(session, deadline));
}

async function withdrawForParty(session) {
    const actor = session?.actor;
    if (!actor) return { ok: false, reason: 'missing_actor' };
    if (!needsPartyWithdrawal(session)) {
        return { ok: true, withdrawn: false, state: session.coldLifeState || null };
    }

    const lock = await waitForWithdrawalLock(session);
    if (!lock.ok) return lock;

    const marketState = session.coldMarketState;
    const rollback = {
        plan: session.plan,
        coldMarketState: marketState || null,
        coldLifeState: session.coldLifeState || null,
        store: lock.store || null,
        storeType: Number(actor.fetchPrivateStoreType?.() || lock.store?.storeType || 0),
        seated: actor.state?.fetchSeated?.() === true
    };

    let withdrawnState = marketState || null;
    try {
        if (marketState) {
            const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
            const result = await ListingService.withdrawForParty(marketState);
            withdrawnState = result.state || marketState;
        }
    } catch (error) {
        if (lock.store) lock.store.repricing = false;
        session.merchantStoreMutation = false;
        return { ok: false, reason: 'store_persist_failed', error: error.message || String(error) };
    }

    const invalidatedWindows = invalidateCustomerWindows(actor);
    applyClosed(actor);
    // Unlike ordinary market maintenance, party withdrawal must remove the
    // store object too. Bot death/recovery treats any remaining object as a
    // merchant marker, even when its storeType has already been reset to zero.
    actor.setPrivateStore?.(null);
    const broadcastWarning = safelyNotify('party withdrawal', () => notifyClosed(session, actor));

    session.plan = 'hunting';
    session.coldMarketState = null;
    if (withdrawnState) session.coldLifeState = withdrawnState;
    session.merchantStoreMutation = false;

    return {
        ok: true,
        withdrawn: true,
        state: withdrawnState,
        rollback,
        invalidatedWindows,
        broadcastWarning
    };
}

async function restoreAfterPartyFailure(session, withdrawal) {
    const actor = session?.actor;
    const rollback = withdrawal?.rollback;
    if (!actor || !rollback) return { ok: false, reason: 'rollback_unavailable' };

    let restoredState = rollback.coldMarketState;
    if (restoredState) {
        const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
        const result = await ListingService.restoreAfterPartyFailure(restoredState);
        restoredState = result.state || restoredState;
    }

    session.plan = rollback.plan;
    session.coldMarketState = restoredState;
    session.coldLifeState = rollback.coldLifeState;
    if (rollback.store) {
        rollback.store.repricing = false;
        actor.setPrivateStore?.(rollback.store);
        actor.setPrivateStoreType?.(rollback.storeType || rollback.store.storeType || 0);
        actor.state?.setSeated?.(rollback.seated);
        safelyNotify('party withdrawal rollback', () => notifyOpened(session, actor, rollback.store));
    }
    return { ok: true, state: restoredState };
}

module.exports = {
    applyLifecycle,
    compactLine,
    lineFor,
    needsPartyWithdrawal,
    republish,
    restoreAfterPartyFailure,
    revision,
    storeFor,
    withdrawForParty
};
