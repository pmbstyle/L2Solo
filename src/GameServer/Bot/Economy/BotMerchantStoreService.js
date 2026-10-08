const refreshPartyMemberships = require('../../World/PartyMembershipPublication');
const { raiseDecision } = require('../AI/DecisionEvents');
const World = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const PARTY_WITHDRAWAL_WAIT_MS = 10000;
const PARTY_WITHDRAWAL_POLL_MS = 10;

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

    const rollback = {
        plan: session.plan,
        coldLifeState: session.coldLifeState || null,
        store: lock.store || null,
        storeType: Number(actor.fetchPrivateStoreType?.() || lock.store?.storeType || 0),
        seated: actor.state?.fetchSeated?.() === true
    };

    const invalidatedWindows = invalidateCustomerWindows(actor);
    applyClosed(actor);
    // Unlike ordinary market maintenance, party withdrawal must remove the
    // store object too. Bot death/recovery treats any remaining object as a
    // merchant marker, even when its storeType has already been reset to zero.
    actor.setPrivateStore?.(null);
    const broadcastWarning = safelyNotify('party withdrawal', () => notifyClosed(session, actor));

    session.plan = 'hunting';
    raiseDecision(session, 'town');
    session.merchantStoreMutation = false;

    return {
        ok: true,
        withdrawn: true,
        state: null,
        rollback,
        invalidatedWindows,
        broadcastWarning
    };
}

async function restoreAfterPartyFailure(session, withdrawal) {
    const actor = session?.actor;
    const rollback = withdrawal?.rollback;
    if (!actor || !rollback) return { ok: false, reason: 'rollback_unavailable' };

    session.plan = rollback.plan;
    session.coldLifeState = rollback.coldLifeState;
    refreshPartyMemberships([session], invoke);
    if (rollback.store) {
        rollback.store.repricing = false;
        actor.setPrivateStore?.(rollback.store);
        actor.setPrivateStoreType?.(rollback.storeType || rollback.store.storeType || 0);
        actor.state?.setSeated?.(rollback.seated);
        safelyNotify('party withdrawal rollback', () => notifyOpened(session, actor, rollback.store));
    }
    return { ok: true, state: null, restoreWarning: null };
}

module.exports = {
    lineFor,
    needsPartyWithdrawal,
    restoreAfterPartyFailure,
    revision,
    storeFor,
    withdrawForParty
};
