(function exposeLeaderboards(root, factory) {
    const leaderboards = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = leaderboards;
    if (root) root.WorldObserverLeaderboards = leaderboards;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const METRICS = Object.freeze({
        level: { label: 'Progress', field: 'level' },
        adena: { label: 'Wealth', field: 'adena' },
        equipmentValue: { label: 'Gear value', field: 'equipmentValue' }
    });
    const RACE_NAMES = Object.freeze({ 0: 'Human', 1: 'Elf', 2: 'Dark Elf', 3: 'Orc', 4: 'Dwarf' });

    function classKey(actor) {
        const classId = Number(actor?.classId ?? actor?.build?.classId);
        if (Number.isInteger(classId) && classId >= 0) return `id:${classId}`;
        const name = actor?.className || actor?.build?.className;
        return name ? `name:${String(name).trim().toLowerCase()}` : null;
    }

    function derivedRaceId(classId) {
        const value = Number(classId);
        if (!Number.isInteger(value) || value < 0) return null;
        if (value <= 17 || (value >= 88 && value <= 98)) return 0;
        if ((value >= 18 && value <= 30) || (value >= 99 && value <= 105)) return 1;
        if ((value >= 31 && value <= 43) || (value >= 106 && value <= 112)) return 2;
        if ((value >= 44 && value <= 52) || (value >= 113 && value <= 116)) return 3;
        if ((value >= 53 && value <= 57) || (value >= 117 && value <= 118)) return 4;
        return null;
    }

    function actorRaceId(actor) {
        const rawRaceId = actor?.raceId;
        if (rawRaceId !== null && rawRaceId !== undefined && rawRaceId !== '') {
            const explicit = Number(rawRaceId);
            if (Number.isInteger(explicit) && explicit >= 0) return explicit;
        }
        return derivedRaceId(actor?.classId ?? actor?.build?.classId);
    }

    function raceKey(actor) {
        const raceId = actorRaceId(actor);
        if (Number.isInteger(raceId) && raceId >= 0) return `id:${raceId}`;
        return actor?.raceName ? `name:${String(actor.raceName).trim().toLowerCase()}` : null;
    }

    function raceName(actor) {
        return actor?.raceName || RACE_NAMES[actorRaceId(actor)] || null;
    }

    function actorKind(actor) {
        return actor?.kind === 'player' ? 'player' : 'bot';
    }

    function eligible(actor) {
        return actorKind(actor) === 'player' || actor?.staticService !== true;
    }

    function metricValue(actor, metric) {
        const definition = METRICS[metric] || METRICS.level;
        return Math.max(0, Number(actor?.[definition.field] || 0));
    }

    function rankActors(actors = [], metric = 'level', filters = {}) {
        const race = String(filters.raceKey || 'all');
        const profession = String(filters.classKey || 'all');
        return actors
            .filter(eligible)
            .filter((actor) => race === 'all' || raceKey(actor) === race)
            .filter((actor) => profession === 'all' || classKey(actor) === profession)
            .sort((left, right) => (
                metricValue(right, metric) - metricValue(left, metric)
                || Number(right.level || 0) - Number(left.level || 0)
                || Number(right.exp || 0) - Number(left.exp || 0)
                || String(left.name || '').localeCompare(String(right.name || ''), 'en', { sensitivity: 'base' })
            ));
    }

    function uniqueOptions(actors, keyFor, labelFor) {
        const options = new Map();
        actors.filter(eligible).forEach((actor) => {
            const key = keyFor(actor);
            const label = labelFor(actor);
            if (key && label && !options.has(key)) options.set(key, String(label));
        });
        return [...options.entries()]
            .map(([key, label]) => ({ key, label }))
            .sort((left, right) => left.label.localeCompare(right.label, 'en', { sensitivity: 'base' }));
    }

    function raceOptions(actors = []) {
        return uniqueOptions(actors, raceKey, raceName);
    }

    function classOptions(actors = [], selectedRace = 'all') {
        const scoped = selectedRace === 'all'
            ? actors
            : actors.filter((actor) => raceKey(actor) === selectedRace);
        return uniqueOptions(scoped, classKey, (actor) => actor.className || actor.build?.className);
    }

    return { METRICS, actorKind, actorRaceId, classKey, classOptions, eligible, metricValue, raceKey, raceName, raceOptions, rankActors };
}));
