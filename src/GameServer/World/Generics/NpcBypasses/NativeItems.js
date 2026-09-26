const service = invoke('GameServer/World/Generics/NativeKnowledgeBase');
const Protocol = invoke('GameServer/World/Generics/NativeItemsProtocol');
const Response = invoke('GameServer/Network/Response');
const Locations = invoke('GameServer/World/Generics/NativeItemLocations');
const Html = invoke('GameServer/World/Generics/HtmlKit');
const Requests = invoke('GameServer/World/Generics/NativeItemRequests');
const CATEGORIES = ['all', 'weapons', 'armor', 'jewelry', 'consumables', 'recipes', 'materials', 'quest', 'other'];
const GRADES = ['all', 'no-grade', 'd', 'c', 'b', 'a', 's'];
function view(session) {
    return session.nativeItemsView ||= { query: '', category: 'all', grade: 'all', tab: 'list', listPage: 0, sourcePage: 0, itemId: 0 };
}
function searchText(value) { return Protocol.text(value, 48).trim(); }
function chanceText(value) {
    const chance = Number(value);
    // Keep two significant digits for rare rewards, up to the catalog's
    // eight decimal places, so a positive catalog chance never displays as zero.
    const digits = chance > 0 && chance < 0.01
        ? Math.min(8, 1 - Math.floor(Math.log10(chance))) : 2;
    return chance.toFixed(digits);
}
function sourceRows(detail, tab, page) {
    const sources = detail.sources[tab], pages = Math.max(1, Math.ceil(sources.length / 8));
    page = Math.min(page, pages - 1);
    const rows = sources.slice(page * 8, page * 8 + 8).map((npc) => {
        const rewards = service().npcDetail(npc.id)?.[tab] || [];
        const rolls = rewards.flatMap((g) => g.items).filter((i) => i.itemId === detail.id);
        // Quantity is per successful roll; probability is the observer's
        // aggregate chance of at least one success across independent groups.
        const low = rolls.length ? Math.min(...rolls.map((r) => r.minAmount)) : 0;
        const high = rolls.length ? Math.max(...rolls.map((r) => r.maxAmount)) : 0;
        return { id: npc.id, name: npc.name, level: npc.level, raid: npc.raidBoss, reachable: npc.knownReachable,
            amount: low === high ? String(low) : `${low}-${high}`, chance: chanceText(npc.chancePercent) };
    });
    return { page, pages, total: sources.length, rows };
}
function snapshot(session, open) {
    const v = view(session);
    const result = { ...v, open, epoch: session.nativeItemsEpoch, revision: ++session.nativeItemsRevision, message: '', rows: [] };
    if (v.tab === 'map') {
        const item = service().itemDetail(v.itemId);
        const places = v.places || [], pages = Math.max(1, Math.ceil(places.length / 8));
        v.mapPage = Math.min(v.mapPage || 0, pages - 1);
        const rows = places.slice(v.mapPage * 8, v.mapPage * 8 + 8);
        if (!rows.some((r) => r.id === v.selected)) v.selected = rows[0]?.id || 0;
        const tracked = places.find((r) => session.nativeItemsWaypoint && Locations.key(r) === Locations.key(session.nativeItemsWaypoint));
        Object.assign(result, { name: item.name, itemGrade: item.grade, kind: item.category,
            drops: item.sources.drops.length, spoils: item.sources.spoils.length,
            mobId: v.mobId, mobName: v.mobName, selected: v.selected, tracked: tracked?.id || 0,
            page: v.mapPage, pages, total: places.length, rows });
        return result;
    }
    if (v.tab !== 'list') {
        const item = service().itemDetail(v.itemId);
        if (item) {
            Object.assign(result, sourceRows(item, v.tab, v.sourcePage), { itemId: item.id, name: item.name,
                itemGrade: item.grade, kind: String(item.kind || '').split('.').slice(1).join(' ') || item.category,
                drops: item.sources.drops.length, spoils: item.sources.spoils.length });
            session.nativeItemsSourceVisible = result.rows.map((r) => r.id);
            v.sourcePage = result.page;
            return result;
        }
        v.tab = result.tab = 'list'; v.itemId = 0; result.message = 'Item unavailable.';
    }
    const page = service().listItems({ q: v.query, category: v.category, grade: v.grade, page: v.listPage + 1, limit: 8, exactFirst: true });
    v.listPage = page.page - 1;
    Object.assign(result, { page: v.listPage, pages: page.pages, total: page.total, itemId: 0,
        rows: page.items.map((item) => ({ id: item.id, name: item.name, grade: item.grade,
            category: item.category, drops: item.hasDropSources, spoils: item.hasSpoilSources })) });
    session.nativeItemsVisible = result.rows.map((r) => r.id);
    return result;
}
function legacy(s) {
    let body = '<html><title>Item Database</title><body>';
    if (s.tab === 'list') {
        body += 'Find an item:<br><edit var="q" width=220><br>' +
            '<button value="Search" action="bypass -h native-items search $q" width=76 height=23 back="L2UI_ch3.Btn1_normalOn" fore="L2UI_ch3.Btn1_normal"><br>';
        for (const r of s.rows) body += `<a action="bypass -h native-items inspect ${r.id}">${Html.esc(r.name)}</a><br1>`;
    } else if (s.tab === 'map') {
        body += `${Html.esc(s.mobName)}<br><a action="bypass -h native-items sources">Back to sources</a><br>`;
        for (const r of s.rows) body += `${r.id}. ${Html.esc(r.name)} (${r.kind}, ${r.period})<br1>` +
            `<a action="bypass -h native-items ${s.tracked === r.id ? 'untrack' : `track ${r.id}`}">${s.tracked === r.id ? 'Stop tracking' : 'Track on radar'}</a><br>`;
        body += '<a action="bypass -h native-items untrack">Clear direction</a><br>Spawn places, not live monsters.<br>';
    } else {
        body += `${Html.esc(s.name)}<br><a action="bypass -h native-items list">Back to items</a><br>` +
            '<a action="bypass -h native-items tab drops">Drop</a> / <a action="bypass -h native-items tab spoils">Spoil</a><br>';
        for (const r of s.rows) body += `${Html.esc(r.name)} Lv ${r.level}: ${Html.esc(r.amount)} / ${r.chance}% <a action="bypass -h native-items map ${r.id}">Map</a><br1>`;
        body += '<br>Server rates; before level penalty.<br>';
    }
    if (!s.rows.length) body += s.tab === 'list' ? 'No matching items.<br>' : s.tab === 'map' ? 'No known spawn locations.<br>' : 'No sources recorded for this item.<br>';
    if (s.page) body += `<a action="bypass -h native-items page ${s.page - 1}">Previous</a> `;
    body += `Page ${s.page + 1}/${s.pages}`;
    if (s.page + 1 < s.pages) body += ` <a action="bypass -h native-items page ${s.page + 1}">Next</a>`;
    return body + '</body></html>';
}
function render(session, open = false) {
    if (!session?.actor || !session.nativeItemsOpen) return;
    const s = snapshot(session, open);
    session.dataSendToMe(Response.npcHtml(session.actor.fetchId(), session.nativeItemsVersion === 1 ? Protocol.encode(s) : legacy(s)));
}
function openNow(session, query = null) {
    if (!session?.actor) return;
    const v = view(session);
    if (query !== null) Object.assign(v, { query: searchText(query), category: 'all', grade: 'all', tab: 'list', listPage: 0 });
    session.nativeItemsOpen = true;
    session.nativeItemsEpoch = (session.nativeItemsEpoch || 0) + 1;
    session.nativeItemsRevision = 0;
    render(session, true);
}
function consume(session, parts) {
    if (!session?.actor) return;
    const action = parts[1], v = view(session);
    if (action === 'close') { session.nativeItemsOpen = false; return; }
    if (action === 'open') {
        if (parts.length !== 3 || !['0', '1'].includes(parts[2])) return;
        session.nativeItemsVersion = Number(parts[2]); return openNow(session);
    }
    if (!session.nativeItemsOpen) return;
    if (action === 'filter') {
        if (parts.length !== 5 || !CATEGORIES.includes(parts[2]) || !GRADES.includes(parts[3]) || parts[4].length > 576) return;
        let query; try { query = parts[4] === '-' ? '' : decodeURIComponent(parts[4]); } catch (_) { return; }
        Object.assign(v, { query: searchText(query), category: parts[2], grade: parts[3], tab: 'list', listPage: 0 });
    } else if (action === 'search') {
        Object.assign(v, { query: searchText(parts.slice(2).join(' ')), tab: 'list', listPage: 0 });
    } else if (action === 'inspect') {
        if (!/^\d{1,7}$/.test(parts[2] || '') || !session.nativeItemsVisible?.includes(Number(parts[2]))) return;
        v.itemId = Number(parts[2]); v.tab = 'drops'; v.sourcePage = 0;
    } else if (action === 'map') {
        if (parts.length !== 3 || !['drops', 'spoils'].includes(v.tab) || !/^\d{1,7}$/.test(parts[2] || '') ||
            !session.nativeItemsSourceVisible?.includes(Number(parts[2]))) return;
        const npc = service().npcDetail(Number(parts[2]));
        if (!npc) return;
        Object.assign(v, { sourceTab: v.tab, tab: 'map', mobId: npc.id, mobName: npc.name,
            mapPage: 0, selected: 0, places: Locations.locations(npc.id, session.actor) });
    } else if (action === 'sources') {
        if (v.tab !== 'map') return;
        v.tab = v.sourceTab;
    } else if (action === 'place' || action === 'track') {
        if (v.tab !== 'map' || parts.length !== 3 || !/^\d{1,6}$/.test(parts[2] || '')) return;
        const place = v.places.slice(v.mapPage * 8, v.mapPage * 8 + 8).find((r) => r.id === Number(parts[2]));
        if (!place) return;
        v.selected = place.id;
        if (action === 'track') Locations.track(session, place);
    } else if (action === 'untrack') {
        if (v.tab !== 'map' || parts.length !== 2) return;
        Locations.stop(session);
    } else if (action === 'tab') {
        if (!v.itemId || !['drops', 'spoils'].includes(parts[2])) return;
        v.tab = parts[2]; v.sourcePage = 0;
    } else if (action === 'list') {
        v.tab = 'list';
    } else if (action === 'page') {
        if (!/^\d{1,6}$/.test(parts[2] || '')) return;
        v[v.tab === 'list' ? 'listPage' : v.tab === 'map' ? 'mapPage' : 'sourcePage'] = Number(parts[2]);
    } else if (action !== 'refresh') return;
    render(session);
}
function open(session, query = null) {
    if (session?.actor) Requests.run(session, () => openNow(session, query));
}
function handler(session, parts) {
    if (!session?.actor) return;
    if (parts[1] === 'close') { Requests.cancel(session); session.nativeItemsOpen = false; return; }
    const request = parts.slice();
    Requests.run(session, () => consume(session, request));
}
Object.assign(handler, { open, render, sourceRows });
module.exports = handler;
