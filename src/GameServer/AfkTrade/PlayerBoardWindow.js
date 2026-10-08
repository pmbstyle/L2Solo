'use strict';
const Html = require('../World/Generics/HtmlKit');
const { SELL, BUY } = require('./BoardIndex');
const { isKind } = require('./BoardRules');
// ARCH-NOTE: the client limit remains unmeasured; use the existing 8192-character
// packet guard and twenty rows, continuing at the first row that does not fit.
const PAGE_SIZE = 20;
const MAX_HTML = 8192;
const word = side => side === BUY ? 'buy' : side === 'workshop' ? side : 'sell';
const sideOf = side => side === 'workshop' ? side : side === 'buy' || Number(side) === BUY ? BUY : SELL;
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const text = (value, fallback, limit = 512) => {
    const source = String(value || fallback);
    if (/\b-?\d+_\d+\b|\bitem\s*\d+\b|\bid=\d+/i.test(source)) return fallback;
    if (Html.esc(source).length <= limit) return source;
    let low = 0, high = Math.min(source.length, limit);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Html.esc(source.slice(0, middle)).length + 1 <= limit) low = middle;
        else high = middle - 1;
    }
    return source.slice(0, low) + '…';
};
const amount = value => Math.max(0, Number(value) || 0).toLocaleString('en-US');
function encodeCursor(cursor, workshop = false) {
    return !cursor ? '-' : workshop ? `${cursor.ownerId}:${cursor.recipeId}` : `${cursor.selfId}:${cursor.n}`;
}
function decodeCursor(value, side) {
    if (!value || value === '-') return null;
    if (!/^\d{1,10}:\d{1,10}$/.test(value)) throw Error('invalid cursor');
    const [a, b] = value.split(':').map(Number);
    return side === 'workshop' ? { ownerId: a, recipeId: b } : { selfId: a, n: b, side };
}

function create({ service = () => require('./PlayerBoardService'),
    afk = () => invoke('GameServer/AfkTrade/AfkTradeService'),
    workshops = () => invoke('GameServer/Bot/Economy/CraftWorkshopService'),
    response = () => invoke('GameServer/Network/Response'),
    townOf = actor => invoke('GameServer/Bot/BotAI').getClosestTownName(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()) } = {}) {
    const itemName = id => text(afk().itemName(id), 'Unknown item');
    function normalize(session, query = {}) {
        return { side: sideOf(query.side), town: Object.hasOwn(query, 'town') ? query.town || null : townOf(session.actor),
            selfId: integer(query.selfId) || 0, cursor: query.cursor || null };
    }
    function command(query, cursor = null) {
        return `board list ${word(query.side)} ${query.town ? encodeURIComponent(query.town) : '-'} ${query.selfId} ${encodeCursor(cursor, query.side === 'workshop')}`;
    }
    function previous(query) {
        // ARCH-NOTE: Previous seeks twenty raw rows without another offer read;
        // hidden rows or HTML clipping can overlap the preceding page. Forward
        // always resumes at the first unseen row, with no page/history cache.
        if (!query.cursor) return null;
        if (query.side !== 'workshop') return afk().boardIndex().previousCursor(query.side,
            { ...query, count: PAGE_SIZE });
        const rows = workshops().boardRecords().filter(shop => !query.town || shop.town === query.town)
            .flatMap(shop => shop.entries.map(entry => ({ ownerId: Number(shop.ownerId), recipeId: Number(entry.recipeId) })))
            .sort((a, b) => a.ownerId - b.ownerId || a.recipeId - b.recipeId);
        const at = rows.findIndex(row => row.ownerId > query.cursor.ownerId
            || row.ownerId === query.cursor.ownerId && row.recipeId >= query.cursor.recipeId);
        return rows[Math.max(0, (at < 0 ? rows.length : at) - PAGE_SIZE)] || null;
    }
    function frame(body, query, next, back) {
        const footer = [back && Html.link('Previous', command(query, back)),
            query.cursor && Html.link('First', command(query)), next && Html.link('Next', command(query, next))]
            .filter(Boolean).join(' / ');
        return Html.page(body, { title: 'Market Board', footer });
    }
    function header(session, query) {
        let body = '<font color="LEVEL">Market Board</font><br>';
        body += [SELL, BUY, 'workshop'].map(side => Html.link(side === SELL ? 'Sell' : side === BUY ? 'Buy' : 'Workshop',
            command({ ...query, side, cursor: null }))).join(' / ') + '<br>';
        body += `Town: ${Html.esc(text(query.town, 'All towns', 64))}<br>`;
        body += Html.link('Your town', command({ ...query, town: townOf(session.actor) })) + ' / '
            + Html.link('All towns', command({ ...query, town: null })) + '<br>';
        const towns = query.side === 'workshop' ? workshops().boardRecords().map(shop => shop.town)
            : [...(afk().boardIndex().townItems.get(query.side)?.keys() || [])];
        let links = '';
        for (const town of [...new Set(towns)].filter(town => town && town !== '*' && town !== query.town).sort().slice(0, 24)) {
            const link = (links ? ' / ' : '') + Html.link(text(town, 'Town', 64), command({ ...query, town }));
            if (links.length + link.length > 2500) break;
            links += link;
        }
        body += links + '<br>';
        if (query.selfId) body += `Item: ${Html.esc(itemName(query.selfId))} / ${Html.link('All items', command({ ...query, selfId: 0 }))}<br>`;
        return body;
    }
    function entryHtml(entry, query) {
        const workshop = entry.kind === 'workshop';
        const name = workshop ? itemName(entry.selfId) : text(entry.itemName, 'Unknown item');
        const owner = text(entry.ownerName, 'Merchant', 100), town = text(entry.town, query.town || 'the local town', 64);
        const request = workshop ? `workshop ${entry.ownerId} ${entry.recipeId} ${entry.price} ${entry.revision ?? '-'}`
            : `${entry.kind} ${entry.id} ${entry.lineId} ${entry.selfId} ${entry.price} ${entry.revision ?? '-'}`;
        const item = Html.link(name, command({ ...query, selfId: entry.selfId }));
        return `${item}${workshop ? '' : ' x ' + amount(entry.count)} — ${amount(entry.price)} a${workshop ? '' : ' each'} — `
            + `${Html.esc(owner)} (${Html.esc(town)}) ${Html.link('answer', 'board answer ' + request)}<br1>`;
    }
    function send(session, html) {
        if (html.length > MAX_HTML) throw Error('board HTML exceeds packet guard');
        session.dataSendToMe(response().npcHtml(session.actor.fetchId(), html));
        return html;
    }
    function show(session, input = {}, message = '') {
        if (!session?.actor) return null;
        const query = normalize(session, input);
        // A player's current filter only; no offers, pages or bot data are cached.
        session.playerBoardView = query;
        const page = service().entries(session, { ...query, kind: query.side === 'workshop' ? 'workshop' : undefined,
            limit: PAGE_SIZE });
        let body = header(session, query) + (message ? Html.esc(text(message, '', 512)) + '<br>' : '');
        let next = page.next;
        const back = previous(query);
        if (!page.available) body += 'The market board is not ready.<br>';
        else if (!page.entries.length) body += 'No matching offers.<br>';
        else for (const entry of page.entries) {
            const row = entryHtml(entry, query);
            if (frame(body + row, query, next || entry.cursor, back).length + 32 > MAX_HTML) { next = entry.cursor; break; }
            body += row;
        }
        return send(session, frame(body, query, next, back));
    }
    async function answer(session, request) {
        const result = await service().answer(session, request);
        const query = session.playerBoardView || normalize(session);
        if (result.action === 'store_opened') return result;
        if (result.ok && result.action === 'confirm_trade') {
            const owner = text(result.ownerName, 'Merchant', 100);
            const verb = result.side === BUY ? 'Sell' : 'Buy';
            const body = `${verb} ${amount(result.amount)} ${Html.esc(itemName(result.selfId))} for ${amount(result.total)} a with ${Html.esc(owner)}?<br>`
                + 'Your goods or payment will be held while you wait here.<br>'
                + Html.link('Agree and wait', 'board agree') + ' / ' + Html.link('Back', command(query, query.cursor));
            send(session, Html.page(body, { title: 'Confirm meeting' }));
        } else if (result.ok && result.action === 'confirm') {
            const name = itemName(result.productId), owner = text(result.ownerName, 'Merchant', 100);
            const body = `Craft ${Html.esc(name)} for ${amount(result.price)} a from ${Html.esc(owner)}?<br>`
                + Html.link('Craft', `board craft ${result.ownerId} ${result.recipeId} ${result.price} ${result.revision}`)
                + ' / ' + Html.link('Back', command(query, query.cursor));
            send(session, Html.page(body, { title: 'Confirm craft' }));
        } else {
            const owner = text(result.ownerName, 'Merchant', 100), town = text(result.town, 'the local town', 64);
            const message = !result.ok ? result.reason === 'record_changed' ? 'This offer has changed.'
                : result.reason === 'own_record' ? 'You cannot answer your own offer.' : 'This offer is unavailable.'
                : result.action === 'crafted' ? 'Craft completed.'
                    : result.action === 'agreed' ? 'Agreed. Wait here for the merchant. Leaving cancels the trade.'
                    : request.kind === 'workshop' ? `${owner} crafts ${itemName(result.productId)} in ${town}. Meet there.`
                        : `${owner} ${result.side === BUY ? 'buys ' + itemName(request.selfId) + ' in ' + town + '. Meet there.' : 'sells in ' + town + '.'}`;
            show(session, query, message);
        }
        return result;
    }
    async function handle(session, parts) {
        try {
            if (parts[1] === 'list' && parts.length === 6) {
                if (!['sell', 'buy', 'workshop'].includes(parts[2]) || integer(parts[4]) === null) return;
                const side = sideOf(parts[2]), town = parts[3] === '-' ? null : decodeURIComponent(parts[3]);
                if (town && town.length > 64) return;
                return show(session, { side, town, selfId: Number(parts[4]), cursor: decodeCursor(parts[5], side) });
            }
            if (parts[1] === 'agree' && parts.length === 2) {
                const prepared = session.playerBoardPreparation;
                return prepared ? answer(session, { ...prepared, confirmed: true }) : show(session, session.playerBoardView || {}, 'This offer is unavailable.');
            }
            let request;
            const revision = value => value === '-' ? null : integer(value);
            if (parts[1] === 'craft' && parts.length === 6) request = { kind: 'workshop', confirmed: true,
                ownerId: integer(parts[2]), recipeId: integer(parts[3]), price: integer(parts[4]), revision: revision(parts[5]) };
            else if (parts[1] === 'answer' && parts[2] === 'workshop' && parts.length === 7) request = { kind: 'workshop',
                ownerId: integer(parts[3]), recipeId: integer(parts[4]), price: integer(parts[5]), revision: revision(parts[6]) };
            else if (parts[1] === 'answer' && isKind(parts[2]) && parts.length === 8) request = { kind: parts[2],
                id: integer(parts[3]), lineId: integer(parts[4]), selfId: integer(parts[5]), price: integer(parts[6]), revision: revision(parts[7]) };
            if (!request || Object.entries(request).some(([key, value]) => key !== 'revision' && value === null)) return;
            return await answer(session, request);
        } catch (error) {
            utils.infoWarn('Board', 'player board request failed: %s', error.message);
            return show(session, session.playerBoardView || {}, 'This offer is unavailable.');
        }
    }
    return { show, answer, handle };
}
const window = create();
module.exports = { ...window, create, PAGE_SIZE, MAX_HTML, encodeCursor, decodeCursor };
