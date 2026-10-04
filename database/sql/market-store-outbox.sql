-- Journal the persisted transition in the same transaction as the bot state.
-- Store identity survives intermediate purchase writes in shopping activity.
-- Only removing/replacing that identity closes a store, including partial WTBs.
-- The row goes to the history outbox; the history thread writes it into
-- market_store_events of the history file (HistoryStore APPLY.market_store).
CREATE TRIGGER IF NOT EXISTS market_store_insert AFTER INSERT ON bot_life_state
WHEN NEW.activity = 'merchant' AND COALESCE(json_extract(NEW.statsJson, '$.marketStore.id'), '') <> ''
BEGIN
    INSERT INTO history_outbox (kind, payload)
    VALUES ('market_store', json_object(
        'storeId', json_extract(NEW.statsJson, '$.marketStore.id'),
        'characterId', NEW.characterId,
        'characterName', NEW.characterName,
        'storeType', COALESCE(json_extract(NEW.statsJson, '$.marketStore.storeType'), 1),
        'eventType', 'opened',
        'reason', COALESCE(json_extract(NEW.statsJson, '$.lastReason'), 'state_transition'),
        'occurredAt', NEW.updatedAt,
        'openedAt', COALESCE(json_extract(NEW.statsJson, '$.marketStore.openedAt'), NEW.updatedAt),
        'town', json_extract(NEW.statsJson, '$.marketStore.town'),
        'itemsJson', COALESCE(json_extract(NEW.statsJson, '$.marketStore.items'), '[]')));
END;

CREATE TRIGGER IF NOT EXISTS market_store_update AFTER UPDATE OF activity, statsJson ON bot_life_state
WHEN COALESCE(json_extract(OLD.statsJson, '$.marketStore.id'), '') <> '' OR NEW.activity = 'merchant'
BEGIN
    INSERT INTO history_outbox (kind, payload)
    SELECT 'market_store', json_object(
        'storeId', json_extract(OLD.statsJson, '$.marketStore.id'),
        'characterId', OLD.characterId,
        'characterName', OLD.characterName,
        'storeType', COALESCE(json_extract(OLD.statsJson, '$.marketStore.storeType'), 1),
        'eventType', 'closed',
        'reason', COALESCE(json_extract(NEW.statsJson, '$.lastReason'), 'state_transition'),
        'occurredAt', NEW.updatedAt,
        'openedAt', COALESCE(json_extract(OLD.statsJson, '$.marketStore.openedAt'), OLD.updatedAt),
        'town', json_extract(OLD.statsJson, '$.marketStore.town'),
        'itemsJson', COALESCE(json_extract(OLD.statsJson, '$.marketStore.items'), '[]'))
    WHERE COALESCE(json_extract(OLD.statsJson, '$.marketStore.id'), '') <> ''
        AND COALESCE(json_extract(NEW.statsJson, '$.marketStore.id'), '') <> json_extract(OLD.statsJson, '$.marketStore.id');

    INSERT INTO history_outbox (kind, payload)
    SELECT 'market_store', json_object(
        'storeId', json_extract(NEW.statsJson, '$.marketStore.id'),
        'characterId', NEW.characterId,
        'characterName', NEW.characterName,
        'storeType', COALESCE(json_extract(NEW.statsJson, '$.marketStore.storeType'), 1),
        'eventType', 'opened',
        'reason', COALESCE(json_extract(NEW.statsJson, '$.lastReason'), 'state_transition'),
        'occurredAt', NEW.updatedAt,
        'openedAt', COALESCE(json_extract(NEW.statsJson, '$.marketStore.openedAt'), NEW.updatedAt),
        'town', json_extract(NEW.statsJson, '$.marketStore.town'),
        'itemsJson', COALESCE(json_extract(NEW.statsJson, '$.marketStore.items'), '[]'))
    WHERE NEW.activity = 'merchant'
        AND COALESCE(json_extract(NEW.statsJson, '$.marketStore.id'), '') <> ''
        AND COALESCE(json_extract(OLD.statsJson, '$.marketStore.id'), '') <> json_extract(NEW.statsJson, '$.marketStore.id');
END;
