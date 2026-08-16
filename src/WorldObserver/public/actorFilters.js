(function exposeActorFilters(root, factory) {
    const filters = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = filters;
    if (root) root.WorldObserverActorFilters = filters;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    function className(actor, catalog = []) {
        const directName = actor?.className || actor?.build?.className;
        if (directName) return directName;

        const rawClassId = actor?.classId ?? actor?.build?.classId;
        const classId = Number(rawClassId);
        if (!Number.isInteger(classId) || classId < 0) return null;

        const entry = catalog.find((item) => Number(item?.classId) === classId);
        return entry?.className || entry?.label || entry?.name || null;
    }

    function classKey(actor) {
        const rawClassId = actor?.classId ?? actor?.build?.classId;
        if (rawClassId !== null && rawClassId !== undefined && String(rawClassId).trim() !== '') {
            const classId = Number(rawClassId);
            if (Number.isInteger(classId) && classId >= 0) return `id:${classId}`;
        }

        const name = className(actor);
        return name ? `name:${String(name).trim().toLowerCase()}` : null;
    }

    function normalizeLevel(value) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const level = Math.floor(Number(value));
        return Number.isFinite(level) ? Math.max(1, Math.min(80, level)) : null;
    }

    function isEligible(actor) {
        if (actor?.kind === 'player') return true;
        if (actor?.staticService === true) return false;
        return String(actor?.role || '').trim().toLowerCase() !== 'crafter';
    }

    function isSurfaceActor(actor) {
        return actor?.area?.mapLayer !== 'dungeon' || Boolean(actor?.area?.mapAnchor);
    }

    function mapLocation(actor) {
        return actor?.area?.mapAnchor || actor?.loc || null;
    }

    function actorKind(actorId, hintedKind, snapshot = {}) {
        if (hintedKind === 'player' || hintedKind === 'bot') return hintedKind;
        if ((snapshot?.players || []).some((actor) => Number(actor.id) === Number(actorId))) return 'player';
        return 'bot';
    }

    function matches(actor, filters = {}) {
        const minLevel = normalizeLevel(filters.minLevel);
        const maxLevel = normalizeLevel(filters.maxLevel);
        const level = Number(actor?.level);
        if ((minLevel !== null || maxLevel !== null) && !Number.isFinite(level)) return false;
        if (minLevel !== null && level < minLevel) return false;
        if (maxLevel !== null && level > maxLevel) return false;

        const selectedClass = String(filters.classKey || 'all');
        return selectedClass === 'all' || classKey(actor) === selectedClass;
    }

    function classOptions(actors = [], catalog = []) {
        const byKey = new Map();

        catalog.forEach((entry) => {
            const classId = Number(entry?.classId);
            const label = entry?.className || entry?.label || entry?.name;
            if (!Number.isInteger(classId) || classId < 0 || !label) return;
            byKey.set(`id:${classId}`, String(label));
        });

        actors.forEach((actor) => {
            const key = classKey(actor);
            const label = className(actor, catalog);
            if (key && label && !byKey.has(key)) byKey.set(key, String(label));
        });
        return [...byKey.entries()]
            .map(([key, label]) => ({ key, label }))
            .sort((left, right) => left.label.localeCompare(right.label, 'en', { sensitivity: 'base' }));
    }

    return { actorKind, classKey, className, classOptions, isEligible, isSurfaceActor, mapLocation, matches, normalizeLevel };
}));
