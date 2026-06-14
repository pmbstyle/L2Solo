const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const SpeckMath = invoke('GameServer/SpeckMath');

const TRADE_RANGE = 1500;

function itemTemplate(selfId) {
    return DataCache.items.find((ob) => ob.selfId === selfId);
}

function isBotSession(session) {
    return session && (session.constructor.name === 'BotSession' || (session.accountId && String(session.accountId).startsWith('bot_')));
}

function isTradableItem(item) {
    return item && !item.fetchEquipped();
}

function actorDistance(a, b) {
    return new SpeckMath.Point3D(a.fetchLocX(), a.fetchLocY(), a.fetchLocZ())
        .distance(new SpeckMath.Point3D(b.fetchLocX(), b.fetchLocY(), b.fetchLocZ()));
}

function actorName(session) {
    return session?.actor?.fetchName?.() || session?.accountId || 'unknown';
}

function summarizeItems(items) {
    return items.map((item) => `${item.count} ${item.name}`).join(', ');
}

function giveItem(actor, sourceItem, amount) {
    const selfId = sourceItem.fetchSelfId();

    return new Promise((resolve, reject) => {
        actor.backpack.stackableExists(selfId).then((existingItem) => {
            const total = existingItem.fetchAmount() + amount;
            Database.updateItemAmount(actor.fetchId(), existingItem.fetchId(), total).then(() => {
                actor.backpack.updateAmount(existingItem.fetchId(), total);
                resolve(existingItem);
            }).catch(reject);
        }).catch(() => {
            const details = itemTemplate(selfId);
            if (!details) {
                reject(new Error(`Unknown item ${selfId}.`));
                return;
            }

            Database.setItem(actor.fetchId(), {
                selfId,
                name: sourceItem.fetchName() || details.template.name,
                amount,
                equipped: false,
                slot: details.etc?.slot ?? 0
            }).then((packet) => {
                actor.backpack.insertItem(Number(packet.insertId), selfId, { amount });
                resolve(actor.backpack.fetchItemRaw(Number(packet.insertId)));
            }).catch(reject);
        });
    });
}

function takeItem(actor, item, amount) {
    return new Promise((resolve, reject) => {
        if (!item || item.fetchAmount() < amount) {
            reject(new Error('Not enough items.'));
            return;
        }

        const total = item.fetchAmount() - amount;
        if (total > 0) {
            Database.updateItemAmount(actor.fetchId(), item.fetchId(), total).then(() => {
                item.setAmount(total);
                resolve();
            }).catch(reject);
            return;
        }

        Database.deleteItem(actor.fetchId(), item.fetchId()).then(() => {
            actor.backpack.items = actor.backpack.items.filter((ob) => ob.fetchId() !== item.fetchId());
            resolve();
        }).catch(reject);
    });
}

const BotTradeService = {
    startPlayerTrade(playerSession, targetSession) {
        if (!playerSession?.actor || !targetSession?.actor || !isBotSession(targetSession)) {
            return { ok: false, reason: 'invalid_target' };
        }

        if (targetSession.plan === 'merchant') {
            return { ok: false, reason: 'merchant_store' };
        }

        if (actorDistance(playerSession.actor, targetSession.actor) > TRADE_RANGE) {
            return { ok: false, reason: 'too_far' };
        }

        playerSession.activeTrade = {
            partnerSession: targetSession,
            partnerActorId: targetSession.actor.fetchId(),
            items: new Map(),
            confirmed: false,
            createdAt: Date.now()
        };

        console.info("BotTrade :: %s opened trade with %s", actorName(playerSession), actorName(targetSession));
        return { ok: true, trade: playerSession.activeTrade };
    },

    addItem(playerSession, objectId, amount) {
        const trade = playerSession.activeTrade;
        if (!trade || trade.confirmed) {
            return { ok: false, reason: 'no_active_trade' };
        }

        const item = playerSession.actor.backpack.fetchItemRaw(objectId);
        const qty = Math.max(1, Math.floor(Number(amount) || 1));
        if (!isTradableItem(item)) {
            return { ok: false, reason: 'item_not_tradable' };
        }

        const current = trade.items.get(objectId);
        const nextCount = Math.min(item.fetchAmount(), (current?.count || 0) + qty);
        if (nextCount <= 0) {
            return { ok: false, reason: 'bad_count' };
        }

        const line = { item, count: nextCount };
        trade.items.set(objectId, line);
        console.info("BotTrade :: %s offered %d %s", actorName(playerSession), line.count, item.fetchName());
        return { ok: true, line };
    },

    cancel(playerSession) {
        if (playerSession) {
            playerSession.activeTrade = null;
        }
    },

    async commit(playerSession) {
        const trade = playerSession.activeTrade;
        if (!trade || trade.confirmed) {
            return { ok: false, reason: 'no_active_trade' };
        }

        const partnerSession = trade.partnerSession;
        if (!playerSession.actor || !partnerSession?.actor || trade.items.size === 0) {
            return { ok: false, reason: 'empty_or_invalid_trade' };
        }

        trade.confirmed = true;
        const moved = [];

        for (const line of trade.items.values()) {
            const liveItem = playerSession.actor.backpack.fetchItemRaw(line.item.fetchId());
            if (!isTradableItem(liveItem) || liveItem.fetchAmount() < line.count) {
                return { ok: false, reason: 'item_changed' };
            }

            await takeItem(playerSession.actor, liveItem, line.count);
            await giveItem(partnerSession.actor, liveItem, line.count);
            moved.push({
                selfId: liveItem.fetchSelfId(),
                name: liveItem.fetchName(),
                count: line.count
            });
        }

        playerSession.activeTrade = null;
        console.info("BotTrade :: %s completed trade with %s: %s", actorName(playerSession), actorName(partnerSession), summarizeItems(moved));
        return { ok: true, partnerSession, moved };
    }
};

module.exports = BotTradeService;
