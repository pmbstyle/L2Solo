(function createAppShell(root) {
    const Router = root.WorldObserverSpaRouter;
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const icon = (name) => `<svg aria-hidden="true"><use href="/observer/ui-icons.svg#${name}"></use></svg>`;
    const sections = [
        ['overview', 'Overview', 'history', '/observer/overview'],
        ['world', 'World map', 'map', '/observer/'],
        ['characters', 'Characters', 'users', '/observer/characters'],
        ['parties', 'Parties', 'users', '/observer/parties'],
        ['clans', 'Clans', 'shield', '/observer/clans'],
        ['market', 'Market', 'coins', '/observer/market'],
        ['database', 'Database', 'search', '/observer/database/items'],
        ['raid-bosses', 'Raid bosses', 'skull', '/observer/raid-bosses'],
        ['rankings', 'Rankings', 'trophy', '/observer/rankings']
    ];
    const navigation = document.createElement('aside');
    navigation.className = 'app-navigation';
    navigation.id = 'appNavigation';
    navigation.innerHTML = `<a class="app-brand" href="/observer/overview"><img src="/observer/world-observer-logo.png" width="40" height="40" alt=""><span><strong>World Observer</strong><small>LINEAGE II · C4</small></span></a>
        <p class="app-nav-label">Explore your world</p>
        <nav aria-label="Main navigation">${sections.map(([key, label, glyph, href]) => `<a href="${href}" data-section="${key}" aria-label="${label}" title="${label}">${icon(glyph)}<span>${label}</span></a>`).join('')}</nav>
        <div class="app-nav-footer"><label for="appearanceSelect">Appearance</label><select id="appearanceSelect"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select><span>A living world, at a glance.</span></div>`;
    const header = document.createElement('header');
    header.className = 'app-header';
    header.innerHTML = `<button class="app-menu-toggle" type="button" aria-label="Open navigation" aria-controls="appNavigation" aria-expanded="false">☰</button><div class="app-page-heading"><span>World Observer</span><strong id="appSectionTitle">World map</strong></div><button class="app-search-button" type="button" aria-label="Search the world">${icon('search')}<span>Search the world</span><kbd>⌘ K</kbd></button><span class="app-connection" role="status"><i></i><span>Live world</span></span>`;
    const liveToggle = document.getElementById('liveToggle') || document.getElementById('marketLiveToggle');
    if (liveToggle) header.insertBefore(liveToggle, header.querySelector('.app-connection'));
    document.body.prepend(header);
    document.body.prepend(navigation);
    document.body.classList.add('has-app-shell');
    const select = navigation.querySelector('select');
    select.value = root.WorldObserverAppearance.preference;
    select.addEventListener('change', () => root.WorldObserverAppearance.set(select.value));
    const menu = header.querySelector('.app-menu-toggle');
    function closeNavigation() { document.body.classList.remove('navigation-open'); menu.setAttribute('aria-expanded', 'false'); }
    menu.addEventListener('click', () => {
        const open = document.body.classList.toggle('navigation-open');
        menu.setAttribute('aria-expanded', String(open));
    });
    function sectionFor(route) {
        if (route.name.startsWith('knowledge-')) return 'database';
        if (route.name === 'actor') return 'characters';
        if (route.name === 'dungeon') return 'world';
        return route.name;
    }
    function update(route = Router.parse(location.pathname + location.search)) {
        if (/^\/observer\/market\/?$/.test(location.pathname)) route = { name: 'market' };
        const active = sectionFor(route);
        navigation.querySelectorAll('[data-section]').forEach((link) => {
            if (link.dataset.section === active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        document.getElementById('appSectionTitle').textContent = route.name === 'actor' ? 'Character profile' : sections.find(([key]) => key === active)?.[1] || 'World map';
    }
    function navigate(href) {
        const route = Router.parse(href);
        const event = new CustomEvent('observer:navigate', { detail: route, cancelable: true });
        if (route.name !== 'not-found' && !root.dispatchEvent(event)) { closeNavigation(); return true; }
        return false;
    }
    navigation.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (navigate(link.getAttribute('href'))) event.preventDefault();
        closeNavigation();
    });
    // Equipment hints live outside scrolling inspectors and stay inside the viewport.
    let equipmentHint = null, hintSlot = null;
    function hideEquipmentHint() {
        equipmentHint?.remove(); equipmentHint = null;
        hintSlot?.removeAttribute('aria-describedby'); hintSlot = null;
    }
    function showEquipmentHint(slot) {
        const source = slot.querySelector('.item-tooltip');
        if (!source || hintSlot === slot) return;
        hideEquipmentHint(); hintSlot = slot;
        equipmentHint = source.cloneNode(true);
        equipmentHint.classList.add('equipment-tooltip'); equipmentHint.id = 'equipmentHint';
        slot.setAttribute('aria-describedby', equipmentHint.id);
        document.body.append(equipmentHint);
        const anchor = slot.getBoundingClientRect(), hint = equipmentHint.getBoundingClientRect(), edge = 12;
        const left = Math.max(edge, Math.min(innerWidth - hint.width - edge, anchor.left + anchor.width / 2 - hint.width / 2));
        const below = anchor.bottom + 8;
        const top = below + hint.height <= innerHeight - edge ? below : Math.max(edge, anchor.top - hint.height - 8);
        equipmentHint.style.left = `${left}px`; equipmentHint.style.top = `${top}px`;
    }
    document.addEventListener('pointerover', event => {
        const slot = event.target.closest('.paperdoll-slot.has-item');
        if (slot) showEquipmentHint(slot);
    });
    document.addEventListener('pointerout', event => {
        if (hintSlot && !hintSlot.contains(event.relatedTarget)) hideEquipmentHint();
    });
    document.addEventListener('focusin', event => {
        const slot = event.target.closest('.paperdoll-slot.has-item');
        if (slot) showEquipmentHint(slot);
    });
    document.addEventListener('focusout', hideEquipmentHint);
    document.addEventListener('scroll', hideEquipmentHint, true);
    window.addEventListener('resize', hideEquipmentHint);
    const inspector = document.getElementById('selectedInspector');
    if (inspector) new MutationObserver(hideEquipmentHint).observe(inspector, { childList: true });

    const dialog = document.createElement('dialog');
    dialog.className = 'world-search-dialog';
    dialog.setAttribute('aria-label', 'Search the world');
    dialog.innerHTML = `<form method="dialog" class="world-search-header"><label>${icon('search')}<input type="search" aria-label="Search characters, items and creatures" placeholder="Characters, items, creatures…" autocomplete="off"></label><button type="submit" aria-label="Close search">Esc</button></form><div class="world-search-results" aria-live="polite">Type at least two characters to search.</div>`;
    document.body.append(dialog);
    const input = dialog.querySelector('input'), results = dialog.querySelector('.world-search-results');
    let searchActors = null, actorPromise = null, controller = null, timer = null, revision = 0;
    function localActors() { return root.WorldObserverShell.getActors?.() || searchActors || []; }
    async function loadSearchActors() {
        if (root.WorldObserverShell.getActors || searchActors) return;
        actorPromise ||= fetch('/observer/api/world/bootstrap').then((response) => {
            if (!response.ok) throw new Error('Characters could not load.');
            return response.json();
        }).then((data) => {
            const snapshot = root.WorldObserverWorldState.decodeBootstrap(data);
            searchActors = [...snapshot.bots.map((actor) => ({ ...actor, kind: 'bot' })), ...snapshot.players.map((actor) => ({ ...actor, kind: 'player' }))];
        }).finally(() => { actorPromise = null; });
        await actorPromise;
    }
    function resultLink(href, name, subtitle, glyph) {
        return `<a href="${escape(href)}">${icon(glyph)}<span><strong>${escape(name)}</strong><small>${escape(subtitle)}</small></span><span aria-hidden="true">↗</span></a>`;
    }
    async function search() {
        const ownRevision = ++revision, query = input.value.trim();
        controller?.abort();
        if (query.length < 2) { results.textContent = 'Type at least two characters to search.'; return; }
        controller = new AbortController();
        const signal = controller.signal;
        results.textContent = 'Searching the world…';
        const [characters, items, npcs, players] = await Promise.allSettled([
            loadSearchActors().then(() => localActors().filter((actor) => `${actor.name} ${actor.className || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6)),
            fetch(`/observer/api/knowledge/items?q=${encodeURIComponent(query)}&limit=5`, { signal }).then((response) => { if (!response.ok) throw new Error(); return response.json(); }),
            fetch(`/observer/api/knowledge/npcs?q=${encodeURIComponent(query)}&limit=5`, { signal }).then((response) => { if (!response.ok) throw new Error(); return response.json(); }),
            fetch(`/observer/api/characters/search?q=${encodeURIComponent(query)}&limit=6`, { signal }).then((response) => { if (!response.ok) throw new Error(); return response.json(); })
        ]);
        if (ownRevision !== revision || !dialog.open) return;
        const groups = [];
        const matches = new Map();
        if (characters.status === 'fulfilled') characters.value.forEach(actor => matches.set(`${actor.kind}:${actor.id}`, actor));
        if (players.status === 'fulfilled') players.value.characters.forEach(actor => matches.set(`player:${actor.id}`, actor));
        const characterMatches = [...matches.values()].sort((a, b) => (a.kind === 'player' ? 0 : 1) - (b.kind === 'player' ? 0 : 1)).slice(0, 8);
        if (characterMatches.length) groups.push(`<h3>Characters</h3>${characterMatches.map((actor) => resultLink(Router.href({ name: 'actor', kind: actor.kind, id: actor.id }), actor.name, `Lv ${actor.level} · ${actor.className || 'Character'}${actor.kind === 'player' ? actor.online === false ? ' · Offline player' : ' · Online player' : ''}`, 'users')).join('')}`);
        if (items.status === 'fulfilled' && items.value.items?.length) groups.push(`<h3>Items</h3>${items.value.items.map((item) => resultLink(Router.href({ name: 'knowledge-items', id: item.id }), item.name, 'Server database', 'warehouse')).join('')}`);
        if (npcs.status === 'fulfilled' && npcs.value.items?.length) groups.push(`<h3>Creatures</h3>${npcs.value.items.map((npc) => resultLink(Router.href({ name: 'knowledge-npcs', id: npc.id }), npc.name, `Lv ${npc.level}`, 'skull')).join('')}`);
        const unavailable = [characters, items, npcs, players].some((group) => group.status === 'rejected');
        results.innerHTML = groups.join('') || '<p class="search-empty">No results found. Try a different name.</p>';
        if (unavailable) results.insertAdjacentHTML('beforeend', '<p class="search-empty">Some results could not load. Please try again.</p>');
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 180); });
    dialog.addEventListener('close', () => { revision += 1; controller?.abort(); clearTimeout(timer); });
    dialog.querySelector('form').addEventListener('submit', (event) => {
        if (event.submitter) return;
        event.preventDefault();
        results.querySelector('a')?.click();
    });
    results.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (navigate(link.getAttribute('href'))) event.preventDefault();
        dialog.close();
    });
    function openSearch() { if (!dialog.open) dialog.showModal(); input.focus(); }
    header.querySelector('.app-search-button').addEventListener('click', openSearch);
    document.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
        if (event.key === 'Escape') closeNavigation();
    });
    root.addEventListener('popstate', () => update());
    root.WorldObserverShell = {
        update,
        getActors: null,
        connection(connected) {
            header.querySelector('.app-connection').classList.toggle('is-disconnected', !connected);
            header.querySelector('.app-connection span').textContent = connected ? 'Live world' : 'Reconnecting…';
        }
    };
    update();
}(window));
