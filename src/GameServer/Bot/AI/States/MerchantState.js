const TradeService = invoke('GameServer/Bot/TradeService');

const AD_COOLDOWN = 8 * 60 * 1000;

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const store = bot.fetchPrivateStore && bot.fetchPrivateStore();
        if (!store || !store.items.length) return;

        const now = Date.now();
        if (session.lastMerchantAdAt && now - session.lastMerchantAdAt < AD_COOLDOWN) return;
        if (Math.random() > 0.035) return;

        session.lastMerchantAdAt = now;

        const town = store.town || BotAI.getClosestTownName(bot.fetchLocX(), bot.fetchLocY());
        const names = TradeService.describeStoreItems(store.items, 3);
        const phrases = store.storeType === 3 ? [
            `WTB ${names}. Buying near ${town}.`,
            `Buying ${names} around ${town}. Paying fair adena.`,
            `WTB local drops: ${names}. Find me in ${town}.`
        ] : [
            `WTS ${names} below shop price. I'm near ${town}.`,
            `Fresh stock: ${names}. Find me in ${town}.`,
            `Selling ${names} around ${town}. Prices are below regular shops.`
        ];

        BotAI.trade(session, phrases[Math.floor(Math.random() * phrases.length)]);
    }
};
