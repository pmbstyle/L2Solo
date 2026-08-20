const Database = invoke('Database');

const DEFAULT_NEIGHBOR_LIMIT = 32;
const MAX_NEIGHBOR_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const MAX_PAYLOAD_CHARS = 4000;
const RELATION_FIELDS = Object.freeze([
    'affinity',
    'trust',
    'respect',
    'fear',
    'hostility',
    'familiarity'
]);

function boundedInteger(value, min, max, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
}

function requiredText(value, name, max, pattern = null) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`social graph ${name} is required`);
    if (normalized.length > max) throw new Error(`social graph ${name} exceeds ${max} characters`);
    if (pattern && !pattern.test(normalized)) throw new Error(`social graph ${name} is invalid`);
    return normalized;
}

function optionalText(value, max) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEntity(value, name = 'entity') {
    if (!value || typeof value !== 'object') throw new Error(`social graph ${name} is required`);
    return {
        kind: requiredText(value.kind, `${name} kind`, 32, /^[a-z][a-z0-9_]*$/),
        externalKey: requiredText(value.externalKey ?? value.key ?? value.id, `${name} key`, 128),
        displayName: optionalText(value.displayName ?? value.name, 128)
    };
}

function normalizeDelta(value = {}) {
    return Object.fromEntries(RELATION_FIELDS.map((field) => [
        field,
        boundedInteger(value[field], -100, 100, 0)
    ]));
}

function encodeJson(value, name) {
    if (value === undefined || value === null) return null;
    let encoded;
    try {
        encoded = JSON.stringify(value);
    } catch (_) {
        throw new Error(`social graph ${name} must be JSON serializable`);
    }
    if (encoded.length > MAX_PAYLOAD_CHARS) {
        throw new Error(`social graph ${name} exceeds ${MAX_PAYLOAD_CHARS} characters`);
    }
    return encoded;
}

function decodeJson(value) {
    if (!value) return null;
    try { return JSON.parse(value); } catch (_) { return null; }
}

function normalizeEntityRow(row, prefix = '') {
    if (!row) return null;
    const id = row[`${prefix}Id`] ?? row.id;
    const kind = row[`${prefix}Kind`] ?? row.kind;
    const externalKey = row[`${prefix}Key`] ?? row.externalKey;
    if (!id || !kind || externalKey === undefined || externalKey === null) return null;
    return {
        id: Number(id),
        kind: String(kind),
        externalKey: String(externalKey),
        displayName: String(row[`${prefix}Name`] ?? row.displayName ?? '')
    };
}

function normalizeRelation(row) {
    if (!row) return null;
    return {
        source: normalizeEntityRow(row, 'source'),
        target: normalizeEntityRow(row, 'target'),
        affinity: Number(row.affinity || 0),
        trust: Number(row.trust || 0),
        respect: Number(row.respect || 0),
        fear: Number(row.fear || 0),
        hostility: Number(row.hostility || 0),
        familiarity: Number(row.familiarity || 0),
        evidenceCount: Number(row.evidenceCount || 0),
        lastEventId: row.lastEventId ? Number(row.lastEventId) : null,
        lastInteractionAt: row.lastInteractionAt ? Number(row.lastInteractionAt) : null,
        updatedAt: Number(row.updatedAt || 0),
        revision: Number(row.revision || 0),
        meta: decodeJson(row.metaJson)
    };
}

function normalizeEvent(row) {
    if (!row) return null;
    return {
        id: Number(row.id || 0),
        eventKey: String(row.eventKey || ''),
        source: normalizeEntityRow(row, 'source'),
        target: normalizeEntityRow(row, 'target'),
        context: normalizeEntityRow(row, 'context'),
        eventType: String(row.eventType || ''),
        magnitude: Number(row.magnitude || 0),
        salience: Number(row.salience || 0),
        delta: Object.fromEntries(RELATION_FIELDS.map((field) => [
            field,
            Number(row[`${field}Delta`] || 0)
        ])),
        occurredAt: Number(row.occurredAt || 0),
        payload: decodeJson(row.payloadJson)
    };
}

function relationSelect(where) {
    return `SELECT relation.*,
            source.id sourceId, source.kind sourceKind, source.externalKey sourceKey, source.displayName sourceName,
            target.id targetId, target.kind targetKind, target.externalKey targetKey, target.displayName targetName
        FROM social_relations relation
        INNER JOIN social_entities source ON source.id = relation.sourceEntityId
        INNER JOIN social_entities target ON target.id = relation.targetEntityId
        WHERE ${where}`;
}

function eventSelect(where) {
    return `SELECT event.*,
            source.id sourceId, source.kind sourceKind, source.externalKey sourceKey, source.displayName sourceName,
            target.id targetId, target.kind targetKind, target.externalKey targetKey, target.displayName targetName,
            context.id contextId, context.kind contextKind, context.externalKey contextKey, context.displayName contextName
        FROM social_events event
        INNER JOIN social_entities source ON source.id = event.sourceEntityId
        INNER JOIN social_entities target ON target.id = event.targetEntityId
        LEFT JOIN social_entities context ON context.id = event.contextEntityId
        WHERE ${where}`;
}

const SocialGraphRepository = {
    RELATION_FIELDS,
    DEFAULT_NEIGHBOR_LIMIT,

    registerEntity(value) {
        const entity = normalizeEntity(value);
        return Database.ensureSocialEntity(entity).then((row) => normalizeEntityRow(row));
    },

    findEntity(value) {
        const entity = normalizeEntity(value);
        return Database.execute([
            `SELECT * FROM social_entities WHERE kind = ? AND externalKey = ? LIMIT 1`,
            [entity.kind, entity.externalKey]
        ], 'social:entity-find').then((rows) => normalizeEntityRow(rows[0]));
    },

    recordEvent(input = {}) {
        const source = normalizeEntity(input.source, 'source');
        const target = normalizeEntity(input.target, 'target');
        if (source.kind === target.kind && source.externalKey === target.externalKey) {
            return Promise.reject(new Error('social relation source and target must differ'));
        }
        const occurredAt = boundedInteger(input.occurredAt, 0, Number.MAX_SAFE_INTEGER, Date.now());
        const normalized = {
            eventKey: requiredText(input.eventKey, 'event key', 160),
            eventType: requiredText(input.eventType, 'event type', 64, /^[a-z][a-z0-9_]*$/),
            source,
            target,
            context: input.context ? normalizeEntity(input.context, 'context') : null,
            magnitude: boundedInteger(input.magnitude, -1000, 1000, 1),
            salience: boundedInteger(input.salience, 1, 10, 1),
            delta: normalizeDelta(input.delta),
            occurredAt,
            payloadJson: encodeJson(input.payload, 'payload'),
            relationMetaJson: encodeJson(input.relationMeta, 'relation meta')
        };
        return Database.commitSocialGraphEvent(normalized).then((result) => ({
            inserted: !!result.inserted,
            event: normalizeEvent(result.event),
            relation: normalizeRelation({
                ...result.relation,
                sourceId: result.event.sourceEntityId,
                sourceKind: result.event.sourceKind,
                sourceKey: result.event.sourceKey,
                sourceName: result.event.sourceName,
                targetId: result.event.targetEntityId,
                targetKind: result.event.targetKind,
                targetKey: result.event.targetKey,
                targetName: result.event.targetName
            })
        }));
    },

    relation(sourceValue, targetValue) {
        const source = normalizeEntity(sourceValue, 'source');
        const target = normalizeEntity(targetValue, 'target');
        return Database.execute([
            `${relationSelect(`source.kind = ? AND source.externalKey = ?
                AND target.kind = ? AND target.externalKey = ?`)} LIMIT 1`,
            [source.kind, source.externalKey, target.kind, target.externalKey]
        ], 'social:relation-read').then((rows) => normalizeRelation(rows[0]));
    },

    neighbors(sourceValue, options = {}) {
        const source = normalizeEntity(sourceValue, 'source');
        const limit = boundedInteger(options.limit, 1, MAX_NEIGHBOR_LIMIT, DEFAULT_NEIGHBOR_LIMIT);
        const targetKinds = [...new Set((options.targetKinds || []).map((kind) => (
            requiredText(kind, 'target kind', 32, /^[a-z][a-z0-9_]*$/)
        )))];
        const kindFilter = targetKinds.length
            ? ` AND target.kind IN (${targetKinds.map(() => '?').join(', ')})`
            : '';
        return Database.execute([
            `${relationSelect(`source.kind = ? AND source.externalKey = ?${kindFilter}`)}
             ORDER BY MAX(
                ABS(relation.affinity), ABS(relation.trust), ABS(relation.respect),
                ABS(relation.fear), ABS(relation.hostility)
             ) DESC, relation.updatedAt DESC
             LIMIT ?`,
            [source.kind, source.externalKey, ...targetKinds, limit]
        ], 'social:neighbors').then((rows) => rows.map(normalizeRelation));
    },

    eventsAfter(lastEventId = 0, limit = DEFAULT_EVENT_LIMIT) {
        const cursor = boundedInteger(lastEventId, 0, Number.MAX_SAFE_INTEGER, 0);
        const safeLimit = boundedInteger(limit, 1, MAX_EVENT_LIMIT, DEFAULT_EVENT_LIMIT);
        return Database.execute([
            `${eventSelect('event.id > ?')} ORDER BY event.id ASC LIMIT ?`,
            [cursor, safeLimit]
        ], 'social:events-after').then((rows) => rows.map(normalizeEvent));
    },

    projectionCursor(consumer) {
        const key = requiredText(consumer, 'projection consumer', 96);
        return Database.execute([
            'SELECT consumer, lastEventId, updatedAt FROM social_projection_cursors WHERE consumer = ? LIMIT 1',
            [key]
        ], 'social:projection-cursor').then((rows) => rows[0] ? ({
            consumer: String(rows[0].consumer),
            lastEventId: Number(rows[0].lastEventId || 0),
            updatedAt: Number(rows[0].updatedAt || 0)
        }) : null);
    },

    advanceProjectionCursor(consumer, lastEventId) {
        const key = requiredText(consumer, 'projection consumer', 96);
        const eventId = boundedInteger(lastEventId, 0, Number.MAX_SAFE_INTEGER, 0);
        const timestamp = Date.now();
        return Database.execute([
            `INSERT INTO social_projection_cursors(consumer, lastEventId, updatedAt)
             VALUES (?, ?, ?)
             ON CONFLICT(consumer) DO UPDATE SET
                lastEventId = MAX(social_projection_cursors.lastEventId, excluded.lastEventId),
                updatedAt = CASE
                    WHEN excluded.lastEventId >= social_projection_cursors.lastEventId THEN excluded.updatedAt
                    ELSE social_projection_cursors.updatedAt
                END`,
            [key, eventId, timestamp]
        ], 'social:projection-advance').then(() => this.projectionCursor(key));
    }
};

module.exports = SocialGraphRepository;
