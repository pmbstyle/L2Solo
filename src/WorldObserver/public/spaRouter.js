(function exposeSpaRouter(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverSpaRouter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSpaRouter() {
    const BASE = '/observer';

    function parse(input = '/') {
        const raw = String(input || '/');
        const queryIndex = raw.indexOf('?');
        const search = queryIndex >= 0 ? raw.slice(queryIndex + 1).split('#', 1)[0] : '';
        let pathname = raw.split(/[?#]/, 1)[0] || '/';
        try {
            pathname = decodeURI(pathname);
        } catch (error) {
            return { name: 'not-found' };
        }
        pathname = pathname.replace(/\/+$/, '') || '/';
        if (pathname === BASE || pathname === `${BASE}/world`) {
            const npcId = Number(new URLSearchParams(search).get('npc')) || null;
            return npcId ? { name: 'world', npcId } : { name: 'world' };
        }
        if (pathname === `${BASE}/rankings`) return { name: 'rankings' };
        if (pathname === `${BASE}/raid-bosses`) return { name: 'raid-bosses', id: null };
        if (pathname === `${BASE}/clans`) return { name: 'clans', id: null };
        if (pathname === `${BASE}/database` || pathname === `${BASE}/database/items`) return { name: 'knowledge-items', id: null };
        if (pathname === `${BASE}/database/npcs`) return { name: 'knowledge-npcs', id: null };

        let match = pathname.match(/^\/observer\/raid-bosses\/(\d+)$/);
        if (match) return { name: 'raid-bosses', id: Number(match[1]) };
        match = pathname.match(/^\/observer\/clans\/(\d+)\/map$/);
        if (match) return { name: 'world', clanId: Number(match[1]) };
        match = pathname.match(/^\/observer\/clans\/(\d+)$/);
        if (match) return { name: 'clans', id: Number(match[1]) };
        match = pathname.match(/^\/observer\/actors\/(bot|player)\/(\d+)$/);
        if (match) return { name: 'actor', kind: match[1], id: Number(match[2]) };
        match = pathname.match(/^\/observer\/database\/items\/(\d+)$/);
        if (match) return { name: 'knowledge-items', id: Number(match[1]) };
        match = pathname.match(/^\/observer\/database\/npcs\/(\d+)$/);
        if (match) return { name: 'knowledge-npcs', id: Number(match[1]) };
        return { name: 'not-found' };
    }

    function href(route = {}) {
        if (route.name === 'knowledge-items') return route.id ? `${BASE}/database/items/${Number(route.id)}` : `${BASE}/database/items`;
        if (route.name === 'knowledge-npcs') return route.id ? `${BASE}/database/npcs/${Number(route.id)}` : `${BASE}/database/npcs`;
        if (route.name === 'rankings') return `${BASE}/rankings`;
        if (route.name === 'world' && Number(route.clanId)) return `${BASE}/clans/${Number(route.clanId)}/map`;
        if (route.name === 'world' && Number(route.npcId)) return `${BASE}/?npc=${Number(route.npcId)}`;
        if (route.name === 'raid-bosses') return route.id ? `${BASE}/raid-bosses/${Number(route.id)}` : `${BASE}/raid-bosses`;
        if (route.name === 'clans') return route.id ? `${BASE}/clans/${Number(route.id)}` : `${BASE}/clans`;
        if (route.name === 'actor' && (route.kind === 'bot' || route.kind === 'player') && Number(route.id)) {
            return `${BASE}/actors/${route.kind}/${Number(route.id)}`;
        }
        return `${BASE}/`;
    }

    function isAppPath(pathname) {
        return parse(pathname).name !== 'not-found';
    }

    return Object.freeze({ BASE, href, isAppPath, parse });
}));
