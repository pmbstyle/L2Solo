const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const TradeService   = invoke('GameServer/Bot/TradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Html           = invoke('GameServer/World/Generics/HtmlKit');

function fold(v) {
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function itemColor(kind) {
    if (kind.startsWith('Weapon')) return Html.COLOR.weapon;
    if (kind.startsWith('Armor') || kind.startsWith('Shield')) return Html.COLOR.armor;
    return Html.COLOR.title;
}

function quantityLinks(prefix, selfId, maxSell) {
    if (maxSell <= 0) return Html.font('None', Html.COLOR.muted);

    const links = [
        Html.link('x1', `${prefix} ${selfId} 1`, { color: Html.COLOR.warn })
    ];
    if (maxSell >= 10) links.push(Html.link('x10', `${prefix} ${selfId} 10`, { color: Html.COLOR.warn }));
    if (maxSell >= 100) links.push(Html.link('x100', `${prefix} ${selfId} 100`, { color: Html.COLOR.warn }));
    if (maxSell > 1) links.push(Html.link('All', `${prefix} ${selfId} ${maxSell}`, { color: Html.COLOR.warn }));
    return links.join('&nbsp;&nbsp;');
}

function buildShopHtml(session, bot) {
    const store = bot.fetchPrivateStore();
    const items = store ? store.items : [];
    const adena = session.actor.backpack.fetchTotalAdena();
    const title = store?.title ?? 'Buyer';

    let rows = '';
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const template = DataCache.items.find(ob => ob.selfId === item.selfId);
        const iname = template?.template?.name ?? 'Unknown';
        const icat = template?.template?.kind ?? '';
        const playerItem = session.actor.backpack.fetchItemFromSelfId(item.selfId);
        const playerCount = playerItem ? playerItem.fetchAmount() : 0;
        const maxSell = Math.min(item.count, playerCount);

        rows += Html.table([
            Html.row([Html.cell(Html.font(iname, itemColor(icat)))])
        ]);
        rows += Html.table([
            Html.row([
                Html.cell(`Have: ${Html.font(fold(playerCount), Html.COLOR.link)}`, { width: 80 }),
                Html.cell(`Price: ${Html.font(`${fold(item.price)}a`, Html.COLOR.ok)}`, { width: 80, align: 'right' }),
                Html.cell(quantityLinks('sell-to-merchant-item', item.selfId, maxSell), { width: 110, align: 'right' })
            ])
        ]);
        if (i < items.length - 1) rows += Html.line('L2UI_CH3.hegaerectangle');
    }

    let body = `${Html.font(`Buying: ${title}`, Html.COLOR.warn)}<br1>`;
    body += `${Html.font('No matching items in your inventory.', Html.COLOR.muted)}<br1>`;
    body += `${Html.font(`Adena: ${fold(adena)}a`, Html.COLOR.ok)}<br>`;
    body += Html.line('L2UI_CH3.hegaerectangle');
    body += rows || Html.emptyState('No Orders', 'This merchant is not buying anything.');
    body += '<br>' + Html.actionFooter([
        { label: 'Close', command: 'npc_talk', color: Html.COLOR.muted }
    ]);
    return Html.page(body, { title: `Buying: ${title}` });
}

module.exports = async function(session, parts) {
    const bot = session.viewedPrivateStoreSeller;
    if (!bot) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "No merchant selected." }));
        return;
    }

    const store = bot.fetchPrivateStore();
    if (!store || store.storeType !== 3 || !store.items.length) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "This merchant is not buying anything." }));
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

    const playerItem = session.actor.backpack.fetchItemFromSelfId(selfId);
    const playerCount = playerItem ? playerItem.fetchAmount() : 0;
    const sellQty = Math.min(qty, playerCount, storeItem.count);
    if (sellQty <= 0) {
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
        return;
    }

    try {
        const sold = await TradeService.sellToStore(session.actor, store, selfId, sellQty);
        BotSocialMemory.recordTradeCompleted(session, bot, `sold ${sold.qty} ${sold.name}`);

        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
    } catch (err) {
        utils.infoWarn("SellToMerchantItem", "sell error: " + err);
        session.dataSendToMe(ServerResponse.actionFailed());
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
    }
};
