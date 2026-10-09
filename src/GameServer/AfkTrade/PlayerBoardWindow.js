'use strict';
const Html = require('../World/Generics/HtmlKit');
const { SELL, BUY } = require('./BoardIndex');
const { isKind } = require('./BoardRules');
// C4 puts adjacent links on separate lines outside table cells. Keep pages
// short and use the native table/edit/combobox subset rather than inline layout.
const PAGE_SIZE = 6;
const MAX_HTML = 8192;
const SEARCH_PAGE_SIZE = 8;
const NAVIGATION_LIMIT = 32;
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
    townOf = actor => invoke('GameServer/Bot/BotAI').getClosestTownName(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()),
    waypoints = () => invoke('GameServer/World/Generics/NativeItemLocations') } = {}) {
    const itemName = id => text(afk().itemName(id), 'Unknown item');
    function normalize(session, query = {}) {
        return { side: sideOf(query.side), town: Object.hasOwn(query, 'town') ? query.town || null : townOf(session.actor),
            selfId: integer(query.selfId) || 0, cursor: query.cursor || null };
    }
    function command(query, cursor = null) {
        return `board list ${word(query.side)} ${query.town ? encodeURIComponent(query.town) : '-'} ${query.selfId} ${encodeCursor(cursor, query.side === 'workshop')}`;
    }
    function previous(session, query) {
        // Only bounded cursor references, never offers or rendered pages. This
        // returns to the actual page after hidden rows or HTML-size clipping.
        const key = JSON.stringify([query.side, query.town, query.selfId]);
        let navigation = session.playerBoardNavigation;
        if (!navigation || navigation.key !== key || !query.cursor) {
            navigation = session.playerBoardNavigation = { key, cursors: [query.cursor], at: 0 };
        } else {
            const cursorKey = encodeCursor(query.cursor, query.side === 'workshop');
            const at = navigation.cursors.findIndex(cursor => encodeCursor(cursor, query.side === 'workshop') === cursorKey);
            if (at >= 0) navigation.at = at;
            else {
                navigation.cursors.splice(navigation.at + 1);
                navigation.cursors.push({ ...query.cursor });
                if (navigation.cursors.length > NAVIGATION_LIMIT) navigation.cursors.shift();
                navigation.at = navigation.cursors.length - 1;
            }
        }
        return navigation.at ? navigation.cursors[navigation.at - 1] : undefined;
    }
    function frame(body, query, next, back) {
        const actions = [];
        if (back !== undefined) actions.push({ label: 'Previous', command: command(query, back) });
        if (query.cursor) actions.push({ label: 'First', command: command(query) });
        if (next) actions.push({ label: 'Next', command: command(query, next) });
        return page(body, actions.length ? Html.actionFooter(actions) : '');
    }
    function page(body, footer = '') {
        // This client keeps the window title "Chat"; <title> inside the NPC
        // body adds a duplicate plain heading instead of renaming the frame.
        return Html.page(Html.table([Html.row([Html.cell(body, { width: Html.WIDTH, align: 'left' })])]), { footer });
    }
    function towns(session, query) {
        const listed = query.side === 'workshop' ? workshops().boardRecords().map(shop => shop.town)
            : [...(afk().boardIndex().townItems.get(query.side)?.keys() || [])];
        return [...new Set([query.town, townOf(session.actor), ...listed])]
            .filter(town => typeof town === 'string' && town && town !== '*' && town.length <= 64 && !/[;\x00-\x1f]/.test(town)).sort();
    }
    function header(session, query) {
        let body = Html.font('Market Board', Html.COLOR.title) + '<br>';
        body += Html.columns([SELL, BUY, 'workshop'].map(side => Html.cell(Html.link(side === SELL ? 'Buy items' : side === BUY ? 'Sell items' : 'Craft',
            command({ ...query, side, cursor: null }), { color: query.side === side ? Html.COLOR.title : Html.COLOR.link }), { width: 90, align: 'center' }))) + '<br1>';
        const selected = query.town || 'All towns';
        const choices = [selected, ...(selected === 'All towns' ? [] : ['All towns']), ...towns(session, query).filter(town => town !== selected)].slice(0, 25);
        body += Html.columns([
            Html.cell('<combobox var="board_town" width=174 height=17 list="' + Html.esc(choices.join(';')) + '">', { width: 184 }),
            Html.cell(Html.button('Set town', 'board town $board_town', { width: 76 }), { width: 86 })
        ]) + '<br1>';
        body += Html.columns([
            Html.cell('<edit var="board_query" width=174 height=15 length=48>', { width: 184 }),
            Html.cell(Html.button('Search', 'board search $board_query', { width: 76 }), { width: 86 })
        ]) + '<br1>';
        body += Html.font('Search by item name. Click an item to compare offers.') + '<br>';
        if (query.selfId) body += Html.columns([
            Html.cell(Html.font(itemName(query.selfId), Html.COLOR.title), { width: 184 }),
            Html.cell(Html.link('All items', command({ ...query, selfId: 0 })), { width: 86, align: 'right' })
        ]) + '<br1>';
        return body;
    }
    function requestOf(entry) {
        return entry.kind === 'workshop' ? `workshop ${entry.ownerId} ${entry.recipeId} ${entry.price} ${entry.revision ?? '-'}`
            : `${entry.kind} ${entry.id} ${entry.lineId} ${entry.selfId} ${entry.price} ${entry.revision ?? '-'}`;
    }
    function entryHtml(entry, query) {
        const workshop = entry.kind === 'workshop';
        const name = workshop ? itemName(entry.selfId) : text(entry.itemName, 'Unknown item');
        const owner = text(entry.ownerName, 'Merchant', 100), town = text(entry.town, query.town || 'the local town', 64);
        const request = requestOf(entry);
        const item = Html.link((entry.enchant ? '+' + amount(entry.enchant) + ' ' : '') + name, command({ ...query, selfId: entry.selfId }));
        const action = workshop ? 'Craft' : query.side === BUY ? 'Sell' : 'Buy';
        const mode = workshop ? 'Crafting fee' : entry.conditional ? 'Meeting offer' : entry.kind === 'shop' ? 'Private shop' : 'Advertisement';
        // Let the native Chat window supply its translucent background.
        return Html.table([
            Html.row([Html.cell(item, { width: 192, align: 'left' }), Html.cell(Html.link(action, 'board answer ' + request), { width: 78, align: 'right' })]),
            `<tr><td width=270 colspan=2 align=left>${Html.font(amount(entry.price) + (workshop ? ' a fee' : ' a each'), Html.COLOR.title)}${workshop ? '' : ' | ' + amount(entry.count) + (query.side === BUY ? ' wanted' : ' available')}</td></tr>`,
            Html.row([Html.cell(`${Html.esc(owner)} (${Html.esc(town)})<br1>${Html.font(mode)}`, { width: 192, align: 'left' }),
                Html.cell(Html.link('Location', 'board locate ' + request), { width: 78, align: 'right' })])
        ]) + '<br1>' + Html.line('L2UI.SquareGray') + '<br1>';
    }
    function search(session, offset = 0) {
        const query = session.playerBoardView || normalize(session);
        const q = String(session.playerBoardSearch || '').toLowerCase();
        if (!q) return show(session, query, 'Enter part of an item name to search.');
        const ids = service().itemIds(session, { side: query.side, town: query.town, kind: query.side === 'workshop' ? 'workshop' : undefined });
        const matches = ids.map(selfId => ({ selfId, name: itemName(selfId) })).filter(row => row.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name) || a.selfId - b.selfId);
        const start = Math.min(offset, Math.max(0, Math.ceil(matches.length / SEARCH_PAGE_SIZE) - 1) * SEARCH_PAGE_SIZE);
        let body = Html.font('Find market offers', Html.COLOR.title) + '<br>'
            + Html.font('Search: ' + session.playerBoardSearch) + '<br1>' + Html.font(query.town || 'All towns') + '<br>';
        for (const row of matches.slice(start, start + SEARCH_PAGE_SIZE)) body += Html.columns([
            Html.cell(Html.link(row.name, command({ ...query, selfId: row.selfId })), { align: 'left' })
        ]) + '<br1>';
        if (!matches.length) body += 'No matching items in this market.<br>';
        const actions = [{ label: 'Back', command: command(query, query.cursor) }];
        if (start) actions.unshift({ label: 'Previous', command: `board searchpage ${start - SEARCH_PAGE_SIZE}` });
        if (start + SEARCH_PAGE_SIZE < matches.length) actions.push({ label: 'Next', command: `board searchpage ${start + SEARCH_PAGE_SIZE}` });
        return send(session, page(body, Html.actionFooter(actions)));
    }
    function send(session, html) {
        if (html.length > MAX_HTML) throw Error('board HTML exceeds packet guard');
        session.dataSendToMe(response().npcHtml(session.actor.fetchId(), html));
        return html;
    }
    function show(session, input = {}, message = '') {
        if (!session?.actor) return null;
        const query = normalize(session, input);
        // Filters and cursor references only; all offers are read fresh.
        session.playerBoardView = query;
        const page = service().entries(session, { ...query, kind: query.side === 'workshop' ? 'workshop' : undefined,
            limit: PAGE_SIZE });
        let body = header(session, query) + (message ? Html.font(text(message, '', 512), Html.COLOR.warn) + '<br>' : '');
        if (session.tradeMeetingPresence) body += 'Waiting for the merchant. Stay here.<br>'
            + Html.actionFooter([{ label: 'Cancel trade', command: 'board cancel' }]) + '<br>';
        if (session.playerBoardWaypoint) body += Html.font('Tracking: ' + session.playerBoardWaypoint.name) + '<br1>'
            + Html.actionFooter([{ label: 'Stop tracking', command: 'board untrack' }]) + '<br1>';
        let next = page.next;
        const back = previous(session, query);
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
        const actor = session.actor;
        const result = await service().answer(session, request);
        if (session.actor !== actor) return result;
        const query = session.playerBoardView || normalize(session);
        if (result.action === 'store_opened') return result;
        if (result.ok && result.action === 'locate') {
            const loc = result.loc, coords = [loc?.locX, loc?.locY, loc?.locZ].map(Number);
            if (!coords.every(n => Number.isSafeInteger(n) && Math.abs(n) <= 2000000)) return show(session, query, 'The merchant location is unavailable.');
            session.playerBoardWaypoint = { x: coords[0], y: coords[1], z: coords[2], name: text(result.ownerName, 'Merchant', 100) };
            waypoints().syncDirection(session, session.playerBoardWaypoint);
            show(session, query, 'Merchant location marked on your radar.');
        } else if (result.ok && result.action === 'confirm_trade') {
            const owner = text(result.ownerName, 'Merchant', 100);
            const verb = result.side === BUY ? 'Sell' : 'Buy';
            const body = Html.font(verb + ' items', Html.COLOR.title) + '<br>' + Html.keyValueRows([
                ['Item', Html.esc(itemName(result.selfId))], ['Quantity', amount(result.amount)],
                ['Total', Html.font(amount(result.total) + ' a', Html.COLOR.title)], ['Merchant', Html.esc(owner)],
                ['Town', Html.esc(text(result.town, 'the local town', 64))]
            ]) + '<br>'
                + 'Your goods or payment will be held while you wait here.<br>'
                + Html.columns([Html.cell('<edit var="board_quantity" width=100 height=15 length=16>', { width: 120 }),
                    Html.cell(Html.button('Set quantity', 'board quantity $board_quantity', { width: 120 }))]) + '<br1>'
                + Html.font('Enter a new quantity, or agree to the amount shown.');
            send(session, page(body, Html.actionFooter([
                { label: 'Agree and wait', command: 'board agree' }, { label: 'Back', command: command(query, query.cursor) }])));
        } else if (result.ok && result.action === 'confirm') {
            const name = itemName(result.productId), owner = text(result.ownerName, 'Merchant', 100);
            let body = Html.font('Confirm craft', Html.COLOR.title) + '<br>' + Html.keyValueRows([
                ['Product', Html.esc(name)], ['Quantity', amount(result.productCount || 1)], ['Fee', amount(result.price) + ' a'],
                ['Crafter', Html.esc(owner)], ...(result.successRate == null ? [] : [['Success', amount(result.successRate) + '%']])
            ]) + '<br>' + 'You supply the materials and the crafting fee.<br1>';
            if (result.materials?.length) body += Html.keyValueRows(result.materials.map(row => [amount(row.amount), Html.esc(itemName(row.selfId))]), { labelWidth: 60 }) + '<br>';
            if (result.successRate != null && result.successRate < 100) body += Html.font('Materials and the fee are spent even if crafting fails.', Html.COLOR.warn) + '<br>';
            send(session, page(body, Html.actionFooter([
                { label: 'Craft', command: `board craft ${result.ownerId} ${result.recipeId} ${result.price} ${result.revision}` },
                { label: 'Back', command: command(query, query.cursor) }])));
        } else {
            const owner = text(result.ownerName, 'Merchant', 100), town = text(result.town, 'the local town', 64);
            const message = !result.ok ? result.reason === 'record_changed' ? 'This offer has changed.'
                : result.reason === 'own_record' ? 'You cannot answer your own offer.'
                    : ({ materials_missing: 'You do not have the required crafting materials.', insufficient_funds: 'You do not have enough adena.',
                        craft_unavailable: 'Crafting is unavailable. Check the materials and try again.', location_unavailable: 'The merchant location is unavailable.' })[result.reason] || 'This offer is unavailable.'
                : result.action === 'crafted' ? 'Craft completed.'
                    : result.action === 'craft_failed' ? 'Crafting failed. Materials and the fee were spent; no item was produced.'
                    : result.action === 'completed' ? 'Trade completed. Goods and payment are delivered.'
                    : result.action === 'cancelled' ? 'Trade cancelled. Unused goods and payment are returned.'
                    : result.action === 'agreed' ? 'Agreed. Wait here for the merchant. Leaving cancels the trade.'
                    : request.kind === 'workshop' ? `${owner} crafts ${itemName(result.productId)} in ${town}. Meet there.`
                        : `${owner} ${result.side === BUY ? 'buys ' + itemName(request.selfId) + ' in ' + town + '. Meet there.' : 'sells in ' + town + '.'}`;
            show(session, query, message);
        }
        return result;
    }
    async function handle(session, parts) {
        const actor = session?.actor;
        try {
            if (!session?.actor) return;
            if (parts[1] === 'town') {
                const query = session.playerBoardView || normalize(session), town = parts.slice(2).join(' ').trim();
                if (town !== 'All towns' && !towns(session, query).includes(town)) return;
                return show(session, { ...query, town: town === 'All towns' ? null : town, cursor: null });
            }
            if (parts[1] === 'search') {
                const searchText = parts.slice(2).join(' ').trim();
                if (!searchText || searchText.length > 48 || /[\x00-\x1f$]/.test(searchText)) return show(session, session.playerBoardView || {}, 'Enter part of an item name to search.');
                session.playerBoardSearch = searchText;
                return search(session);
            }
            if (parts[1] === 'searchpage' && parts.length === 3 && integer(parts[2]) !== null && Number(parts[2]) <= 100000) return search(session, Number(parts[2]));
            if (parts[1] === 'untrack' && parts.length === 2) {
                if (session.playerBoardWaypoint) {
                    session.playerBoardWaypoint = undefined;
                    waypoints().syncDirection(session, session.nativeItemsWaypoint);
                }
                return show(session, session.playerBoardView || {});
            }
            if (parts[1] === 'list' && parts.length === 6) {
                if (!['sell', 'buy', 'workshop'].includes(parts[2]) || integer(parts[4]) === null) return;
                const side = sideOf(parts[2]), town = parts[3] === '-' ? null : decodeURIComponent(parts[3]);
                if (town && town.length > 64) return;
                return show(session, { side, town, selfId: Number(parts[4]), cursor: decodeCursor(parts[5], side) });
            }
            if (parts[1] === 'quantity' && parts.length === 3) {
                const prepared = session.playerBoardPreparation, count = integer(parts[2]);
                if (!prepared || !count) return show(session, session.playerBoardView || {}, 'Enter a positive whole quantity.');
                return answer(session, { ...prepared, amount: count, confirmed: false });
            }
            if (parts[1] === 'cancel' && parts.length === 2) {
                const actor = session.actor, cancelled = await service().cancel(session);
                if (actor !== session.actor) return;
                if (cancelled?.ok === false) return show(session, session.playerBoardView || {}, 'The trade could not be cancelled. Try again.');
                return show(session, session.playerBoardView || {}, 'Trade cancelled. Unused goods and payment are returned.');
            }
            if (parts[1] === 'agree' && parts.length === 2) {
                const prepared = session.playerBoardPreparation;
                return prepared ? answer(session, { ...prepared, confirmed: true }) : show(session, session.playerBoardView || {}, 'This offer is unavailable.');
            }
            let request;
            const revision = value => value === '-' ? null : integer(value);
            if (parts[1] === 'craft' && parts.length === 6) request = { kind: 'workshop', confirmed: true,
                ownerId: integer(parts[2]), recipeId: integer(parts[3]), price: integer(parts[4]), revision: revision(parts[5]) };
            else if (['answer', 'locate'].includes(parts[1]) && parts[2] === 'workshop' && parts.length === 7) request = { kind: 'workshop',
                ownerId: integer(parts[3]), recipeId: integer(parts[4]), price: integer(parts[5]), revision: revision(parts[6]) };
            else if (['answer', 'locate'].includes(parts[1]) && isKind(parts[2]) && parts.length === 8) request = { kind: parts[2],
                id: integer(parts[3]), lineId: integer(parts[4]), selfId: integer(parts[5]), price: integer(parts[6]), revision: revision(parts[7]) };
            if (!request || Object.entries(request).some(([key, value]) => key !== 'revision' && value === null)) return;
            if (parts[1] === 'locate') request.locateOnly = true;
            return await answer(session, request);
        } catch (error) {
            utils.infoWarn('Board', 'player board request failed: %s', error.message);
            if (session?.actor !== actor) return;
            return show(session, session.playerBoardView || {}, 'This offer is unavailable.');
        }
    }
    function meetingResult(session, meeting) {
        if (meeting.state === 'accepted' || session.playerBoardMeetingResult === meeting.id) return;
        session.playerBoardMeetingResult = meeting.id;
        return show(session, session.playerBoardView || {}, meeting.state === 'completed'
            ? 'Trade completed. Goods and payment are delivered.'
            : 'Trade cancelled. Unused goods and payment are returned.');
    }
    return { show, answer, handle, meetingResult };
}
const window = create();
module.exports = { ...window, create, PAGE_SIZE, MAX_HTML, encodeCursor, decodeCursor };
