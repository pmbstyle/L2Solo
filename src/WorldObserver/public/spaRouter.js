(function exposeSpaRouter(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldObserverSpaRouter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSpaRouter() {
    const BASE = '/observer';

    function parse(input = '/') {
        let pathname = String(input || '/').split(/[?#]/, 1)[0] || '/';
        try {
            pathname = decodeURI(pathname);
        } catch (error) {
            return { name: 'not-found' };
        }
        pathname = pathname.replace(/\/+$/, '') || '/';
        if (pathname === BASE || pathname === `${BASE}/world`) return { name: 'world' };
        if (pathname === `${BASE}/rankings`) return { name: 'rankings' };
        if (pathname === `${BASE}/raid-bosses`) return { name: 'raid-bosses', id: null };
        if (pathname === `${BASE}/clans`) return { name: 'clans', id: null };

        let match = pathname.match(/^\/observer\/raid-bosses\/(\d+)$/);
        if (match) return { name: 'raid-bosses', id: Number(match[1]) };
        match = pathname.match(/^\/observer\/clans\/(\d+)$/);
        if (match) return { name: 'clans', id: Number(match[1]) };
        match = pathname.match(/^\/observer\/actors\/(bot|player)\/(\d+)$/);
        if (match) return { name: 'actor', kind: match[1], id: Number(match[2]) };
        return { name: 'not-found' };
    }

    function href(route = {}) {
        if (route.name === 'rankings') return `${BASE}/rankings`;
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
