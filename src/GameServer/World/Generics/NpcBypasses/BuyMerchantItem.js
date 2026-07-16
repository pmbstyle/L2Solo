const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LifeState      = invoke('GameServer/Bot/Population/BotLifeState');
const BotManager     = invoke('GameServer/Bot/BotManager');
const Cooldown       = invoke('GameServer/Bot/Population/Cooldown');
const GoalExecutor   = invoke('GameServer/Bot/Goals/GoalExecutor');
const Html           = invoke('GameServer/World/Generics/HtmlKit');

function fold(v) {
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function itemColor(kind) {
    if (kind.startsWith('Weapon')) return Html.COLOR.weapon;
    if (kind.startsWith('Armor') || kind.startsWith('Shield')) return Html.COLOR.armor;
    return Html.COLOR.title;
}

function quantityLinks(prefix, selfId, stock) {
    const links = [
        Html.link('x1', `${prefix} ${selfId} 1`, { color: Html.COLOR.warn })
    ];
    if (stock >= 10) links.push(Html.link('x10', `${prefix} ${selfId} 10`, { color: Html.COLOR.warn }));
    if (stock >= 100) links.push(Html.link('x100', `${prefix} ${selfId} 100`, { color: Html.COLOR.warn }));
    if (stock > 1) links.push(Html.link('All', `${prefix} ${selfId} ${stock}`, { color: Html.COLOR.warn }));
    return links.join('&nbsp;&nbsp;');
}

function buildShopHtml(session, bot) {
    const store = bot.fetchPrivateStore();
    const items = store ? store.items : [];
    const adena = session.actor.backpack.fetchTotalAdena();
    const title = store?.title ?? 'Merchant';

    let rows = '';
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const template = DataCache.items.find(ob => ob.selfId === item.selfId);
        const iname = template?.template?.name ?? 'Unknown';
        const icat = template?.template?.kind ?? '';
        const c = item.count;
        const buys = quantityLinks('buy-merchant-item', item.selfId, c);

        rows += Html.table([
            Html.row([Html.cell(Html.font(iname, itemColor(icat)))])
        ]);
        rows += Html.table([
            Html.row([
                Html.cell(`Stock: ${Html.font(fold(c), Html.COLOR.link)}`, { width: 80 }),
                Html.cell(`Price: ${Html.font(`${fold(item.price)}a`, Html.COLOR.ok)}`, { width: 80, align: 'right' }),
                Html.cell(buys, { width: 110, align: 'right' })
            ])
        ]);
        if (i < items.length - 1) rows += Html.line('L2UI_CH3.hegaerectangle');
    }

    let body = `${Html.font(title, Html.COLOR.warn)}<br1>`;
    body += `${Html.font(`Adena: ${fold(adena)}a`, Html.COLOR.ok)}<br>`;
    body += Html.line('L2UI_CH3.hegaerectangle');
    body += rows || Html.emptyState('No Stock', 'This merchant has nothing for sale.');
    body += '<br>' + Html.actionFooter([
        { label: 'Close', command: 'npc_talk', color: Html.COLOR.muted }
    ]);
    return Html.page(body, { title });
}

module.exports = async function(session, parts) {
    const bot = session.viewedPrivateStoreSeller;
    if (!bot) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "No merchant selected." }));
        return;
    }

    const store = bot.fetchPrivateStore();
    if (!store || store.storeType !== 1 || !store.items.length) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "This merchant has nothing for sale." }));
        return;
    }

    if (parts.length < 2) {
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
        return;
    }

    const selfId = parseInt(parts[1]);
    const rawQty = parseInt(parts[2]);
    const qty = isNaN(rawQty) || rawQty < 1 ? 1 : rawQty;

    const storeItem = store.items.find(i => i.selfId === selfId);
    if (!storeItem) {
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
        return;
    }

    const buyQty = Math.min(qty, storeItem.count);
    if (buyQty <= 0) return;

    const totalCost = storeItem.price * buyQty;
    const playerAdena = session.actor.backpack.fetchTotalAdena();
    if (playerAdena < totalCost) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "You do not have enough Adena." }));
        return;
    }

    try {
        const bought = await TradeService.buyFromStore(session.actor, store, selfId, buyQty);
        const soldOut = !store.items.some((item) => Number(item.count || 0) > 0);
        const sellerSession = BotManager.sessions.find((candidate) => candidate.actor === bot);
        if (sellerSession?.coldMarketState) {
            const updatedSeller = await LifeState.applyMarketSale(sellerSession.coldMarketState, {
                selfId,
                price: storeItem.price,
                buyerCharacterId: session.actor.fetchId(),
                storeItem
            }, bought.qty);
            if (updatedSeller) sellerSession.coldMarketState = updatedSeller;

            // A dynamic seller has no reason to remain seated after its last
            // item is bought. Preserve its planned return trip, remove the
            // now-empty store, and hand it back to cold simulation.
            const returnState = soldOut ? GoalExecutor.finishMarketVisit(updatedSeller) : null;
            if (returnState) {
                const departingState = {
                    ...returnState,
                    stats: { ...(returnState.stats || {}), marketStore: null }
                };
                await Cooldown.transitionToColdState(sellerSession, departingState, 'market_sold_out');
            }
        }
        BotSocialMemory.recordTradeCompleted(session, bot, `bought ${bought.qty} ${bought.name}`);

        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        if (soldOut) {
            session.viewedPrivateStoreSeller = null;
            session.dataSendToMe(ServerResponse.actionFailed());
        } else {
            session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
        }
    } catch (err) {
        utils.infoWarn("BuyMerchantItem", "purchase error: " + err);
        session.dataSendToMe(ServerResponse.actionFailed());
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
    }
};
