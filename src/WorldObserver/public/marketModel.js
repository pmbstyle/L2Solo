(function (root, factory) {
    const model = factory();
    if (typeof module === 'object' && module.exports) module.exports = model;
    else root.MarketModel = model;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function activeOffers(data) {
        const items = new Map((data?.items || []).map((item) => [Number(item.selfId), item]));
        return (data?.stores || []).flatMap((store) => (store.items || []).map((line, index) => {
            const selfId = Number(line.selfId);
            const item = items.get(selfId) || {};
            return {
                key: `${store.id}:${selfId}:${index}`,
                storeId: String(store.id),
                selfId,
                name: item.name || line.name || `Item ${selfId}`,
                grade: item.grade || null,
                category: item.category || null,
                iconUrl: item.iconUrl || null,
                side: store.side,
                source: store.source,
                town: store.town || 'Unknown',
                ownerName: store.ownerName || 'Unknown trader',
                ownerId: store.ownerId || null,
                title: store.title || '',
                loc: store.loc || null,
                count: Math.max(0, Number(line.count || 0)),
                price: Math.max(0, Number(line.price || 0)),
                enchant: Math.max(0, Number(line.enchant || 0))
            };
        })).filter((offer) => offer.selfId > 0 && offer.count > 0 && offer.price > 0);
    }

    function sourceMatches(source, filter) {
        if (filter === 'all') return true;
        if (filter === 'fixed') return source === 'fixed';
        if (filter === 'players') return source === 'player' || source === 'afk_player';
        if (filter === 'bots') return source === 'bot' || source === 'afk_bot';
        return source !== 'fixed';
    }

    function filterOffers(offers, filters = {}) {
        const query = String(filters.query || '').trim().toLowerCase().replace(/^#(?=\d)/, '');
        return offers.filter((offer) => {
            if (filters.side && offer.side !== filters.side) return false;
            if (!sourceMatches(offer.source, filters.source || 'market')) return false;
            if (filters.town && filters.town !== 'all' && offer.town !== filters.town) return false;
            if (filters.category && filters.category !== 'all' && offer.category !== filters.category) return false;
            if (query && ![offer.name, offer.selfId, offer.ownerName, offer.title]
                .some((part) => String(part || '').toLowerCase().includes(query))) return false;
            return true;
        });
    }

    function bestFirst(side) {
        return (left, right) => side === 'wtb'
            ? right.price - left.price || right.count - left.count
            : left.price - right.price || right.count - left.count;
    }

    function groupOffers(offers, side) {
        const byItem = new Map();
        offers.forEach((offer) => {
            let group = byItem.get(offer.selfId);
            if (!group) {
                group = { selfId: offer.selfId, name: offer.name, grade: offer.grade,
                    category: offer.category, iconUrl: offer.iconUrl, offers: [], units: 0 };
                byItem.set(offer.selfId, group);
            }
            group.offers.push(offer);
            group.units += offer.count;
        });
        return [...byItem.values()].map((group) => {
            group.offers.sort(bestFirst(side));
            group.best = group.offers[0];
            return group;
        });
    }

    function sortRows(rows, { side = 'wts', sort = 'shops', view = 'items' } = {}) {
        const sorted = [...rows];
        const count = (row) => view === 'items' ? row.offers.length : 1;
        const units = (row) => view === 'items' ? row.units : row.count;
        const price = (row) => view === 'items' ? row.best.price : row.price;
        const compareName = (left, right) => left.name.localeCompare(right.name) || left.selfId - right.selfId;
        sorted.sort((left, right) => {
            if (sort === 'units') return units(right) - units(left) || compareName(left, right);
            if (sort === 'price') return (side === 'wtb' ? price(right) - price(left) : price(left) - price(right)) || compareName(left, right);
            if (sort === 'name') return compareName(left, right) || (side === 'wtb' ? price(right) - price(left) : price(left) - price(right));
            return count(right) - count(left) || units(right) - units(left) || compareName(left, right);
        });
        return sorted;
    }

    function summary(offers) {
        return {
            shops: new Set(offers.map((offer) => offer.storeId)).size,
            listings: offers.length,
            units: offers.reduce((total, offer) => total + offer.count, 0),
            items: new Set(offers.map((offer) => offer.selfId)).size
        };
    }

    function economy(data) {
        const current = data?.economy || {};
        const buckets = [...(current.adena?.buckets || [])].sort((left, right) => right.at - left.at);
        const completed = buckets.filter((row) => !row.partial && row.observed);
        return { counters: current.counters || [], buckets,
            available: Boolean(current.adena),
            completed: completed.reduce((sum, row) => ({
                hours: sum.hours + 1, sources: sum.sources + row.sources,
                sinks: sum.sinks + row.sinks, net: sum.net + row.net
            }), { hours: 0, sources: 0, sinks: 0, net: 0 }) };
    }

    return Object.freeze({ activeOffers, filterOffers, groupOffers, sortRows, summary, economy });
}));
