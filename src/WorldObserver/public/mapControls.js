(function exposeMapControls(root) {
    function create(options) {
        const { state, getMeta, getMetrics, project, applyViewport, renderViewport, renderLabels, renderRaids, getActors, getSelected, navigate } = options;
        const destination = document.getElementById('mapDestination');
        const followButton = document.getElementById('mapFollowButton');
        let destinationSignature = '', preferences = null, destinationPlace = null;
        const svg = document.getElementById('worldMap');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        marker.setAttribute('class', 'map-destination-marker');
        svg.append(marker);
        function renderMarker() {
            marker.replaceChildren();
            if (!destinationPlace) return;
            const point = project(destinationPlace.loc);
            const units = 1 / getMetrics().scale;
            const circle = document.createElementNS(svg.namespaceURI, 'circle');
            circle.setAttribute('cx', point.x); circle.setAttribute('cy', point.y); circle.setAttribute('r', units * 10);
            circle.setAttribute('stroke-width', units * 3);
            const label = document.createElementNS(svg.namespaceURI, 'text');
            label.setAttribute('x', point.x); label.setAttribute('y', point.y - units * 19);
            label.setAttribute('font-size', units * 13); label.setAttribute('stroke-width', units * 4); label.textContent = destinationPlace.name;
            marker.append(circle, label);
        }
        try { preferences = JSON.parse(sessionStorage.getItem('observer.map') || 'null'); } catch (_) { /* A fresh map is usable without storage. */ }
        if (preferences && typeof preferences === 'object') {
            if (preferences.viewport && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(preferences.viewport[key]))) state.viewport = preferences.viewport;
            state.showMapLabels = preferences.labels !== false;
            state.showMapRaids = preferences.raids === true;
            const filters = preferences.filters || {};
            if (['all', 'hot', 'cold', 'player', 'raidbosses'].includes(filters.phase)) state.phase = filters.phase;
            state.search = typeof filters.search === 'string' ? filters.search : '';
            state.classKey = typeof filters.classKey === 'string' ? filters.classKey : 'all';
            for (const key of ['minLevel', 'maxLevel']) state[key] = Number.isFinite(filters[key]) ? filters[key] : null;
            document.getElementById('actorSearch').value = state.search;
            document.getElementById('minLevelFilter').value = state.minLevel ?? '';
            document.getElementById('maxLevelFilter').value = state.maxLevel ?? '';
            document.querySelectorAll('[data-phase]').forEach((button) => button.classList.toggle('is-active', button.dataset.phase === state.phase));
        }
        function syncSelection() {
            followButton.disabled = !getSelected()?.loc;
            if (followButton.disabled) state.followCharacter = false;
            followButton.setAttribute('aria-pressed', String(state.followCharacter));
        }
        function save() {
            try { sessionStorage.setItem('observer.map', JSON.stringify({ viewport: state.viewport, labels: state.showMapLabels, raids: state.showMapRaids, filters: { phase: state.phase, search: state.search, classKey: state.classKey, minLevel: state.minLevel, maxLevel: state.maxLevel } })); } catch (_) { /* Do not interrupt map interaction. */ }
        }
        function places() {
            const snapshot = state.snapshot;
            if (!snapshot) return [];
            const areas = snapshot.areas || [...new Map(getActors().filter((actor) => actor.area?.mapAnchor).map((actor) => [actor.area.id, actor.area])).values()];
            return [
                ...(snapshot.labels || []).map((entry) => ({ id: `town:${entry.name}`, name: entry.name, loc: entry, kind: 'Town' })),
                ...areas.filter((entry) => entry.mapAnchor).map((entry) => ({ id: `area:${entry.id}`, name: entry.name, loc: entry.mapAnchor, kind: 'Dungeon' }))
            ];
        }
        function renderDestinations() {
            const entries = places();
            const signature = JSON.stringify(entries);
            if (signature === destinationSignature) return;
            destinationSignature = signature;
            const selected = destination.value;
            destination.replaceChildren(new Option('Choose a town or dungeon', ''));
            for (const kind of ['Town', 'Dungeon']) {
                const group = document.createElement('optgroup'); group.label = kind === 'Town' ? 'Towns & villages' : 'Dungeons';
                entries.filter((entry) => entry.kind === kind).forEach((entry) => group.append(new Option(entry.name, entry.id)));
                destination.append(group);
            }
            destination.value = selected;
        }
        function focus(value) {
            const place = places().find((entry) => entry.id === value);
            if (!place) return false;
            const point = project(place.loc);
            destinationPlace = place;
            state.followCharacter = false; followButton.setAttribute('aria-pressed', 'false');
            const rect = document.getElementById('worldMap').getBoundingClientRect();
            const aspect = Math.max(.5, rect.width / Math.max(1, rect.height));
            const height = 2800, width = height * aspect;
            applyViewport({ x: point.x - width / 2, y: point.y - height / 2, width, height });
            destination.value = value;
            const old = document.getElementById('destinationGuide'); old?.remove();
            if (place.kind === 'Dungeon') {
                const guide = document.createElement('a'); guide.id = 'destinationGuide'; guide.className = 'app-button'; guide.dataset.appRoute = '';
                guide.href = `/observer/dungeons/${value.slice(5)}`; guide.textContent = 'Explore dungeon →';
                destination.closest('.map-tools').append(guide);
            }
            return true;
        }
        function focusSelected() {
            const actor = getSelected();
            if (!actor?.loc) return;
            const point = project(actor.area?.mapAnchor || actor.loc);
            const meta = getMeta();
            const viewport = state.viewport || { width: meta.width, height: meta.height };
            const rect = document.getElementById('worldMap').getBoundingClientRect();
            const width = Math.min(viewport.width, 2200), height = width / Math.max(.5, rect.width / Math.max(1, rect.height));
            applyViewport({ x: point.x - width / 2, y: point.y - height / 2, width, height });
        }
        destination.addEventListener('change', () => {
            if (!focus(destination.value)) return;
            if (destination.value.startsWith('area:')) navigate({ name: 'world', areaId: destination.value.slice(5) }, false);
        });
        document.getElementById('wholeWorldButton').addEventListener('click', () => {
            const meta = getMeta(); state.followCharacter = false; destinationPlace = null; renderMarker();
            followButton.setAttribute('aria-pressed', 'false'); destination.value = '';
            document.getElementById('destinationGuide')?.remove();
            applyViewport({ x: 0, y: 0, width: meta.width, height: meta.height });
        });
        const labelsButton = document.getElementById('mapLabelsToggle'), raidsButton = document.getElementById('mapRaidsToggle');
        labelsButton.setAttribute('aria-pressed', String(state.showMapLabels)); raidsButton.setAttribute('aria-pressed', String(state.showMapRaids));
        labelsButton.addEventListener('click', () => { state.showMapLabels = !state.showMapLabels; labelsButton.setAttribute('aria-pressed', String(state.showMapLabels)); renderLabels(); save(); });
        raidsButton.addEventListener('click', () => { state.showMapRaids = !state.showMapRaids; raidsButton.setAttribute('aria-pressed', String(state.showMapRaids)); renderRaids(); save(); });
        followButton.addEventListener('click', () => {
            if (!getSelected()) return;
            state.followCharacter = !state.followCharacter;
            followButton.textContent = 'Follow character'; followButton.setAttribute('aria-pressed', String(state.followCharacter));
            if (state.followCharacter) focusSelected();
        });
        document.querySelector('.map-toolbar').addEventListener('input', save);
        document.querySelector('.map-toolbar').addEventListener('change', save);
        document.querySelector('.map-toolbar').addEventListener('click', save);
        document.getElementById('worldMap').addEventListener('pointerdown', () => { state.followCharacter = false; followButton.setAttribute('aria-pressed', 'false'); });
        window.addEventListener('pagehide', save);
        const observer = new ResizeObserver(() => { if (document.body.dataset.view === 'world') renderViewport(); });
        observer.observe(document.getElementById('worldMap'));
        return { save, syncSelection, renderDestinations, renderMarker, focus, focusSelected, updateFollow() { if (state.followCharacter && document.body.dataset.view === 'world') focusSelected(); } };
    }
    root.WorldObserverMapControls = { create };
}(window));
