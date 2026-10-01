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
            const areaId = new URLSearchParams(search).get('area');
            if (areaId) return { name: 'world', areaId };
            return npcId ? { name: 'world', npcId } : { name: 'world' };
        }
        const params = new URLSearchParams(search);
        if (pathname === `${BASE}/overview`) return { name: 'overview' };
        if (pathname === `${BASE}/market`) return { name: 'market' };
        if (pathname === `${BASE}/characters` || pathname === `${BASE}/parties`) {
            const route = { name: pathname.endsWith('/parties') ? 'parties' : 'characters' };
            if (params.get('q')) route.query = params.get('q');
            if (params.get('kind')) route.kind = params.get('kind');
            if (params.get('area')) route.areaId = params.get('area');
            if (params.get('class')) route.classId = params.get('class');
            if (['name', 'adena'].includes(params.get('sort'))) route.sort = params.get('sort');
            if (Number(params.get('page')) > 1) route.page = Math.floor(Number(params.get('page')));
            return route;
        }
        if (pathname === `${BASE}/rankings`) return { name: 'rankings' };
        if (pathname === `${BASE}/raid-bosses`) return { name: 'raid-bosses', id: null };
        if (pathname === `${BASE}/clans`) return { name: 'clans', id: null };
        if (pathname === `${BASE}/database` || pathname === `${BASE}/database/items`) return { name: 'knowledge-items', id: null };
        if (pathname === `${BASE}/database/npcs`) return { name: 'knowledge-npcs', id: null };

        const dungeon = pathname.match(/^\/observer\/dungeons\/([a-z0-9_-]+)$/);
        if (dungeon) return { name: 'dungeon', id: dungeon[1] };
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
        if (route.name === 'overview') return `${BASE}/overview`;
        if (route.name === 'market') return `${BASE}/market`;
        if (route.name === 'dungeon' && /^[a-z0-9_-]+$/.test(route.id)) return `${BASE}/dungeons/${route.id}`;
        if (route.name === 'characters' || route.name === 'parties') {
            const params = new URLSearchParams();
            if (route.query) params.set('q', route.query);
            if (route.kind && route.kind !== 'all') params.set('kind', route.kind);
            if (route.areaId) params.set('area', route.areaId);
            if (route.classId !== undefined && route.classId !== '') params.set('class', route.classId);
            if (route.sort && route.sort !== 'level') params.set('sort', route.sort);
            if (Number(route.page) > 1) params.set('page', Math.floor(Number(route.page)));
            return `${BASE}/${route.name}${params.size ? '?' + params.toString() : ''}`;
        }
        if (route.name === 'world' && route.areaId) return `${BASE}/?area=${encodeURIComponent(route.areaId)}`;
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
