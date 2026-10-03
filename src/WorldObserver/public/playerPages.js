(function exposePlayerPages(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverPlayerPages = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPlayerPages() {
    function groupParties(actors = []) {
        const parties = new Map();
        actors.forEach((actor) => {
            if (!actor.party?.id) return;
            const id = String(actor.party.id);
            if (!parties.has(id)) parties.set(id, { id, leaderId: actor.party.leaderId || actor.party.leader?.id || null, members: [] });
            const party = parties.get(id);
            if (!party.members.some((member) => member.kind === actor.kind && member.id === actor.id)) party.members.push(actor);
        });
        return [...parties.values()].map((party) => {
            const leader = party.members.find((actor) => Number(actor.id) === Number(party.leaderId));
            return { ...party, leader, name: leader?.name || party.members[0]?.party?.leader?.name || 'Adventuring party',
                averageLevel: Math.round(party.members.reduce((sum, actor) => sum + Number(actor.level || 1), 0) / party.members.length),
                location: leader?.area?.name || leader?.region || party.members[0]?.area?.name || party.members[0]?.region || 'Unknown location' };
        }).sort((a, b) => b.averageLevel - a.averageLevel || a.name.localeCompare(b.name));
    }
    function filterCharacters(actors, filters = {}) {
        const query = String(filters.query || '').trim().toLowerCase();
        return actors.filter((actor) => {
            if (filters.kind === 'players' && actor.kind !== 'player') return false;
            if (filters.kind === 'bots' && actor.kind === 'player') return false;
            if (filters.kind === 'adventurers' && (actor.kind === 'player' || actor.staticService || actor.role === 'crafter')) return false;
            if (filters.kind === 'services' && !actor.staticService && actor.role !== 'crafter') return false;
            if (filters.classId && String(actor.classId) !== String(filters.classId)) return false;
            if (filters.areaId && actor.area?.id !== filters.areaId) return false;
            if (Number(actor.level) < Number(filters.minLevel || 1) || Number(actor.level) > Number(filters.maxLevel || 99)) return false;
            return !query || [actor.name, actor.className, actor.role, actor.area?.name, actor.region, actor.mode].filter(Boolean).join(' ').toLowerCase().includes(query);
        }).sort((a, b) => {
            if (filters.sort === 'name') return String(a.name).localeCompare(String(b.name));
            if (filters.sort === 'adena') return Number(b.adena || 0) - Number(a.adena || 0) || String(a.name).localeCompare(String(b.name));
            return Number(b.level || 0) - Number(a.level || 0) || String(a.name).localeCompare(String(b.name));
        });
    }
    function paginate(items, page = 1, size = 50) {
        const pages = Math.max(1, Math.ceil(items.length / size));
        const current = Math.min(pages, Math.max(1, Number(page) || 1));
        const offset = (current - 1) * size;
        return { items: items.slice(offset, offset + size), page: current, pages, total: items.length, from: items.length ? offset + 1 : 0, to: Math.min(items.length, offset + size) };
    }
    function create(options) {
        const { getSnapshot, getActors, getClans, navigate, rememberRoute, activityLabel, roleLabel } = options;
        const Router = window.WorldObserverSpaRouter;
        const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
        const number = (value) => Number(value || 0).toLocaleString('en');
        const compact = (value) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
        const href = (actor) => Router.href({ name: 'actor', kind: actor.kind === 'player' ? 'player' : 'bot', id: actor.id });
        const host = document.getElementById('playerPage');
        let route = null, page = 1, lastSignature = null, filters = {}, market = null, marketAt = 0, marketLoading = false;
        function heading(eyebrow, title, description) {
            return `<header class="page-intro"><div><span class="section-kicker">${escape(eyebrow)}</span><h1>${escape(title)}</h1><p>${escape(description)}</p></div></header>`;
        }
        function metric(label, value, note, link) {
            return `<a class="overview-metric" href="${link}"><span>${label}</span><strong>${value}</strong><small>${note}</small></a>`;
        }
        async function loadMarket() {
            if (marketLoading || Date.now() - marketAt < 60000) return;
            marketLoading = true;
            try {
                const response = await fetch('/observer/api/market');
                if (!response.ok) throw new Error();
                market = await response.json();
                const supplemental = await fetch('/observer/item-icons/supplemental.json').then(response => response.ok ? response.json() : {}).catch(() => ({}));
                const items = new Map((market.items || []).map(item => [Number(item.selfId), item]));
                await Promise.all((market.transactions?.recent || []).slice(0, 5).map(async trade => {
                    trade.iconUrl ||= items.get(Number(trade.selfId))?.iconUrl;
                    if (!trade.iconUrl && supplemental.items?.[trade.selfId]?.localFile) trade.iconUrl = `/observer/item-icons/${encodeURIComponent(supplemental.items[trade.selfId].localFile)}`;
                    if (trade.iconUrl) return;
                    try {
                        const detail = await fetch(`/observer/api/knowledge/items/${Number(trade.selfId)}`);
                        if (detail.ok) trade.iconUrl = (await detail.json()).iconUrl;
                    } catch (_) { /* Trading activity remains usable when an icon is unavailable. */ }
                }));
                marketAt = Date.now();
            } catch (_) { marketAt = Date.now(); }
            finally { marketLoading = false; if (route?.name === 'overview') render(true); }
        }
        function rowIdentity(name, subtitle, iconUrl, crest = false) {
            const graphic = iconUrl ? `<img src="${escape(iconUrl)}" alt="" loading="lazy" decoding="async">` : `<span aria-hidden="true">${escape(String(name || '?').slice(0, 1))}</span>`;
            return `<span class="overview-identity"><span class="overview-row-icon${crest ? ' is-crest' : ''}">${graphic}</span><span><strong>${escape(name)}</strong><small>${subtitle}</small></span></span>`;
        }
        function overview() {
            const snapshot = getSnapshot();
            if (!snapshot) return heading('Your world', 'Aden, alive.', 'Discover the people, places and stories in your world.') + '<div class="directory-empty">Loading the world…</div>';
            const actors = getActors(), population = snapshot.population || {}, clans = getClans(), groups = groupParties(actors);
            const adventurers = actors.filter((actor) => actor.kind !== 'player' && !actor.staticService && actor.role !== 'crafter');
            const towns = new Map();
            adventurers.forEach((actor) => {
                const name = actor.area?.name || actor.region || 'Unknown location';
                towns.set(name, (towns.get(name) || 0) + 1);
            });
            const busyPlaces = [...towns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
            const week = market?.history?.windows?.week;
            const tradeTape = (market?.transactions?.recent || []).slice(0, 5);
            return heading('Your world', 'Aden, alive.', 'Discover the people, places and stories in your world.') +
                `<div class="overview-metrics">${metric('Bots in the world', number(population.total || snapshot.bots.length), `${number(adventurers.length)} adventurers · traders and crafters included`, '/observer/characters')}${metric('Online players', number(snapshot.players.length), 'Players currently connected', '/observer/characters?kind=players')}${metric('Adventuring parties', number(population.parties || groups.length), 'Explore their members and destinations', '/observer/parties')}${metric('Clans', number(clans.length), 'Shared goals, resources and adventures', '/observer/clans')}</div>
                <div class="overview-grid"><section class="overview-card"><header><h2>Find your next adventure</h2><a href="/observer/">Open world map ↗</a></header><a class="overview-map-preview" href="/observer/"><img src="/observer/map-tiles/overview.webp" alt="Aden surface atlas"><span>Explore Aden →</span></a><div class="overview-list">${busyPlaces.map(([name, count]) => `<a href="/observer/characters?q=${encodeURIComponent(name)}"><span><strong>${escape(name)}</strong></span><span>${number(count)} adventurers</span></a>`).join('')}</div></section>
                <section class="overview-card"><header><h2>Clan life</h2><a href="/observer/clans">View all ↗</a></header><p>Meet the clans shaping the world.</p><div class="overview-list">${clans.slice(0, 6).map((clan) => `<a href="${Router.href({ name: 'clans', id: clan.id })}">${rowIdentity(clan.name, `Level ${number(clan.level)} · ${number(clan.memberCount || clan.members?.total || 0)} members`, clan.crestUrl, true)}<span>Explore →</span></a>`).join('') || '<p class="search-empty">No clans to show yet.</p>'}</div></section>
                <section class="overview-card"><header><h2>Market activity</h2><a href="/observer/market">Open market ↗</a></header><p>${week ? `${compact(week.trades)} trades · ${compact(week.adena)} Adena over the last 7 days. Includes fixed traders.` : 'Loading trading activity…'}</p><div class="overview-list">${tradeTape.map((trade) => `<a href="/observer/market?item=${Number(trade.selfId)}">${rowIdentity(trade.itemName || 'Item', `${number(trade.quantity)} units · ${escape(trade.town || 'Unknown town')}`, trade.iconUrl)}<span>${compact(trade.adena)} A</span></a>`).join('') || '<p class="search-empty">Recent trades will appear here.</p>'}</div></section>
                <section class="overview-card"><header><h2>Raid watch</h2><a href="/observer/raid-bosses">View all ↗</a></header><p>${number(snapshot.raidBosses?.counts?.alive)} bosses in the world · ${number(snapshot.raidBosses?.counts?.respawning)} returning.</p><div class="overview-list">${(snapshot.raidBosses?.bosses || []).filter((boss) => boss.status === 'respawning').sort((a, b) => a.respawnAt - b.respawnAt).slice(0, 5).map((boss) => `<a href="/observer/raid-bosses"><span><strong>${escape(boss.name)}</strong><small>Lv ${number(boss.level)} · ${escape(boss.location?.name)}</small></span><span>${new Date(boss.respawnAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}</span></a>`).join('') || '<p class="search-empty">No respawn timers running. Browse the raid directory to find a boss.</p>'}</div></section></div>`;
        }
        function controls() {
            const snapshot = getSnapshot();
            return `<div class="directory-controls"><label class="directory-search"><input type="search" id="directorySearch" aria-label="Find a character" placeholder="Name, class or location…" value="${escape(filters.query || '')}"></label><label>Show<select id="directoryKind"><option value="all">All characters</option><option value="adventurers">Adventuring bots</option><option value="players">Online players</option><option value="bots">All bots</option><option value="services">Traders & crafters</option></select></label><label>Class<select id="directoryClass"><option value="">All classes</option>${(snapshot?.classes || []).map((entry) => `<option value="${Number(entry.classId)}">${escape(entry.className || entry.name)}</option>`).join('')}</select></label><label>Sort<select id="directorySort"><option value="level">Highest level</option><option value="name">Name</option><option value="adena">Wealth</option></select></label></div>`;
        }
        function table(actors) {
            return `<div class="directory-table-shell"><table class="directory-table"><thead><tr><th>Character</th><th>Class</th><th>Level</th><th>Activity</th><th>Location</th><th>Party</th></tr></thead><tbody>${actors.map((actor) => `<tr><td><a href="${href(actor)}"><strong>${escape(actor.name)}</strong><small>${actor.kind === 'player' ? 'Player' : actor.staticService ? 'Trader / service' : 'Bot'}${actor.isPk ? ' · PK' : ''}</small></a></td><td>${escape(actor.className || 'Unknown class')}</td><td>${number(actor.level)}</td><td>${escape(actor.kind === 'player' ? 'Online' : activityLabel(actor.mode))}</td><td>${escape(actor.area?.name || actor.region || 'Unknown location')}</td><td>${actor.party?.id ? `<a href="/observer/parties?q=${encodeURIComponent(actor.party.leader?.name || actor.name)}">In a party →</a>` : 'Solo'}</td></tr>`).join('') || '<tr><td colspan="6" class="directory-empty">No characters match these filters.</td></tr>'}</tbody></table></div>`;
        }
        function pagination(result) {
            return `<div class="directory-pagination"><span>${number(result.from)}–${number(result.to)} of ${number(result.total)} characters</span><div><button class="app-button" type="button" data-directory-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>← Previous</button><span class="app-button">${result.page} / ${result.pages}</span><button class="app-button" type="button" data-directory-page="${result.page + 1}" ${result.page >= result.pages ? 'disabled' : ''}>Next →</button></div></div>`;
        }
        function directory() {
            const result = paginate(filterCharacters(getActors(), filters), page); page = result.page;
            return heading('People of Aden', 'Characters', 'Find an adventurer, meet a player, or explore the traders and crafters in your world.') + controls() + `<div id="directoryResults">${table(result.items)}${pagination(result)}</div>`;
        }
        function parties() {
            if (!getSnapshot()) return heading('Better together', 'Adventuring parties', 'Meet the groups exploring Aden.') + '<div class="directory-empty">Loading parties…</div>';
            const all = groupParties(getActors());
            const groups = all.filter((party) => [party.name, party.location, ...party.members.map((member) => [member.name, member.area?.name, member.region].filter(Boolean).join(' '))].join(' ').toLowerCase().includes(String(filters.query || '').toLowerCase()));
            return heading('Better together', 'Adventuring parties', 'Meet the groups exploring Aden. Open a member to see their equipment and current activity.') + `<div class="directory-controls"><label class="directory-search"><input type="search" id="partySearch" aria-label="Find a party" placeholder="Leader, member or location…" value="${escape(filters.query || '')}"></label><span id="partyCount">${number(groups.length)} parties</span></div><div class="party-grid" id="partyResults">${partyCards(groups)}</div>`;
        }
        function partyCards(groups) {
            return groups.map((party) => `<section class="party-card"><header><div><h2>${escape(party.name)}'s party</h2><p>${escape(party.location)} · average level ${number(party.averageLevel)}</p></div><span>${party.members.length} members</span></header><div class="party-members">${party.members.map((actor) => `<a href="${href(actor)}">${escape(actor.name)}<br><span>Lv ${number(actor.level)} · ${escape(roleLabel(actor.party?.role || actor.role))}</span></a>`).join('')}</div></section>`).join('') || '<div class="directory-empty">No parties match this view.</div>';
        }
        function dungeon() {
            const snapshot = getSnapshot();
            if (!snapshot) return heading('Places of Aden', 'Loading location…', 'Finding the adventurers and raid bosses here.') + '<div class="directory-empty">Loading the world…</div>';
            const area = (snapshot?.areas || []).find((entry) => entry.id === route.id) || getActors().find((actor) => actor.area?.id === route.id)?.area;
            if (!area) return heading('Places of Aden', 'Location unavailable', 'This location could not be found.') + '<a class="app-button" href="/observer/">Return to world map</a>';
            const residents = getActors().filter((actor) => actor.area?.id === area.id);
            const bosses = (snapshot?.raidBosses?.bosses || []).filter((boss) => boss.location?.area?.id === area.id);
            return heading('Places of Aden', area.name, `Explore the adventurers and raid bosses inside ${area.name}. Surface markers show the entrance.`) + `<div class="overview-metrics">${metric('Characters inside', number(residents.length), 'Current residents', `/observer/characters?area=${encodeURIComponent(area.id)}`)}${metric('Parties inside', number(groupParties(residents).length), 'Groups with members in this dungeon', `/observer/parties?q=${encodeURIComponent(area.name)}`)}${metric('Raid bosses', number(bosses.length), `${number(bosses.filter((boss) => boss.status === 'alive').length)} in the world`, '/observer/raid-bosses')}</div><p class="dungeon-entrance"><a class="app-button" href="/observer/?area=${encodeURIComponent(area.id)}">Show entrance on world map ↗</a></p><div class="page-intro"><div><h2>Residents</h2><p>Open a character to see their equipment, party and current activity.</p></div></div>${table(residents)}<section class="overview-card" style="margin-top:20px"><header><h2>Raid bosses</h2></header><div class="overview-list">${bosses.map((boss) => `<a href="/observer/raid-bosses${boss.status === 'alive' ? '/' + boss.id : ''}"><span><strong>${escape(boss.name)}</strong><small>Lv ${number(boss.level)}</small></span><span>${boss.status === 'alive' ? 'In world' : boss.status === 'respawning' ? 'Respawning' : 'Not in world'}</span></a>`).join('') || '<p class="search-empty">No raid bosses listed for this dungeon.</p>'}</div></section>`;
        }
        function render(force = false) {
            if (!route || !['overview', 'characters', 'parties', 'dungeon'].includes(route.name)) return;
            const signature = JSON.stringify([route, getSnapshot()?.revision, getSnapshot()?.generatedAt, getClans().length, marketAt]);
            if (!force && signature === lastSignature) return;
            lastSignature = signature;
            if (route.name === 'overview') loadMarket();
            if (route.name === 'characters' && host.querySelector('#directoryResults')) {
                const select = host.querySelector('#directoryClass');
                const html = '<option value="">All classes</option>' + (getSnapshot()?.classes || []).map(entry => `<option value="${Number(entry.classId)}">${escape(entry.className || entry.name)}</option>`).join('');
                if (select.innerHTML !== html) { select.innerHTML = html; select.value = filters.classId || ''; }
                const result = paginate(filterCharacters(getActors(), filters), page); page = result.page;
                host.querySelector('#directoryResults').innerHTML = table(result.items) + pagination(result); return;
            }
            if (route.name === 'parties' && host.querySelector('#partyResults')) {
                const groups = groupParties(getActors()).filter((party) => [party.name, party.location, ...party.members.map((member) => [member.name, member.area?.name, member.region].filter(Boolean).join(' '))].join(' ').toLowerCase().includes(String(filters.query || '').toLowerCase()));
                host.querySelector('#partyResults').innerHTML = partyCards(groups); host.querySelector('#partyCount').textContent = `${number(groups.length)} parties`; return;
            }
            host.innerHTML = route.name === 'overview' ? overview() : route.name === 'characters' ? directory() : route.name === 'parties' ? parties() : dungeon();
            if (route.name === 'characters') {
                document.getElementById('directoryKind').value = filters.kind || 'all';
                document.getElementById('directoryClass').value = filters.classId || '';
                document.getElementById('directorySort').value = filters.sort || 'level';
            }
        }
        function show(next) {
            const changed = JSON.stringify(route) !== JSON.stringify(next);
            route = next;
            if (changed) {
                page = Number(next.page) || 1; filters = { query: next.query || '', kind: next.kind || 'all', areaId: next.areaId || '', classId: next.classId || '', sort: next.sort || 'level' }; host.innerHTML = ''; lastSignature = null;
            }
            host.hidden = !['overview', 'characters', 'parties', 'dungeon'].includes(next.name);
            render(true);
            if (next.name === 'overview') loadMarket();
        }
        function remember() {
            route = { name: route.name, ...filters, page };
            rememberRoute?.(route);
        }
        host.addEventListener('click', (event) => {
            const button = event.target.closest('[data-directory-page]');
            if (button) { page = Number(button.dataset.directoryPage); render(true); remember(); document.getElementById('directoryResults')?.scrollIntoView({ block: 'start' }); return; }
            const link = event.target.closest('a');
            if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const next = Router.parse(link.getAttribute('href'));
            if (next.name === 'not-found' || next.name === 'market' || next.name.startsWith('knowledge-')) return;
            event.preventDefault(); navigate(next);
        });
        host.addEventListener('input', (event) => {
            if (event.target.id === 'directorySearch' || event.target.id === 'partySearch') { filters.query = event.target.value; page = 1; render(true); remember(); }
        });
        host.addEventListener('change', (event) => {
            const key = { directoryKind: 'kind', directoryClass: 'classId', directorySort: 'sort' }[event.target.id];
            if (key) { filters[key] = event.target.value; page = 1; render(true); remember(); }
        });
        return { show, render };
    }
    return { groupParties, filterCharacters, paginate, create };
}));
