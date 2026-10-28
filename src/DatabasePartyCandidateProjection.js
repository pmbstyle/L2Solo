// A small JSON read model, updated atomically by every state writer. Eligibility
// remains in the authoritative life row's covering index.
const paths = ['$.role', '$.generatedIndex', '$.partyRequest', '$.clanPartyObjective', '$.equipmentPlan', '$.partyHistory'];
const table = 'bot_party_candidate_projection';
// One parse of the large document per statement, not one per projected field.
const payload = prefix => `json_extract(${prefix}.statsJson, ${paths.map(path => `'${path}'`).join(', ')})`;

// Party formation reads its candidates through this covering index.
function createIndex(connection) {
    connection.exec(`
        DROP INDEX IF EXISTS bot_life_state_party_candidate_projection;
        CREATE INDEX bot_life_state_party_candidate_projection ON bot_life_state(
            phase, partyId, activity, partyObjectiveSpot,
            partyRequestStatus, partyRequestPriority, updatedAt, level,
            characterId, characterName, activityStartedAt, simulationRevision, spotId
        );
    `);
}

function install(connection) {
    const upsert = `INSERT INTO ${table} (characterId, payloadJson)
        VALUES (NEW.characterId, ${payload('NEW')})
        ON CONFLICT(characterId) DO UPDATE SET payloadJson = excluded.payloadJson
        WHERE payloadJson IS NOT excluded.payloadJson;`;
    connection.exec(`
        CREATE TABLE ${table} (
            characterId INTEGER PRIMARY KEY REFERENCES bot_life_state(characterId) ON DELETE CASCADE,
            payloadJson TEXT
        );
        INSERT INTO ${table} (characterId, payloadJson)
            SELECT life.characterId, ${payload('life')} FROM bot_life_state life;
    `);
    createIndex(connection);
    connection.exec(`
        CREATE TRIGGER bot_party_candidate_insert AFTER INSERT ON bot_life_state BEGIN
            ${upsert}
        END;
        CREATE TRIGGER bot_party_candidate_payload AFTER UPDATE OF statsJson ON bot_life_state
        WHEN OLD.statsJson IS NOT NEW.statsJson BEGIN
            ${upsert}
        END;
        CREATE TRIGGER bot_party_candidate_delete AFTER DELETE ON bot_life_state BEGIN
            DELETE FROM ${table} WHERE characterId = OLD.characterId;
        END;
    `);
}

// Whether a bot is an ordinary party candidate, from its life row and its character row c.
const ordinary = life => `CASE WHEN (c.username LIKE 'bot_pop_%' OR c.username LIKE 'bot_scale_%'
        OR ${life}.accountName LIKE 'bot_pop_%' OR ${life}.accountName LIKE 'bot_scale_%'
        OR CAST(json_extract(${life}.statsJson, '$.generatedCold') AS INTEGER) = 1)
    AND c.username NOT LIKE 'bot_craft_%' AND COALESCE(${life}.accountName, '') NOT LIKE 'bot_craft_%'
    AND json_extract(${life}.statsJson, '$.craftStationId') IS NULL
    AND json_extract(${life}.statsJson, '$.craftShop') IS NULL
    AND json_extract(${life}.statsJson, '$.playerPartyTakeover') IS NULL THEN 1 ELSE 0 END`;
// The phase says who runs the bot: a far bot without a party at a spot can join.
const availability = (life, eligible) => `CASE WHEN ${eligible} = 1 AND ${life}.phase = 'cold'
    AND (${life}.partyId IS NULL OR ${life}.partyId = '')
    AND ${life}.spotId IS NOT NULL AND ${life}.activity IN ('hunting','resting','party_wait') THEN 1 ELSE 0 END`;
const select = `SELECT life.characterId, ${payload('life')},
    COALESCE(c.classId, CAST(json_extract(life.statsJson, '$.classId') AS INTEGER), 0),
    life.level, COALESCE(c.clanId, 0), ${ordinary('life')}, ${availability('life', `(${ordinary('life')})`)}
    FROM bot_life_state life INNER JOIN characters c ON c.id = life.characterId`;
const insert = where => `INSERT INTO ${table}(characterId,payloadJson,classId,level,clanId,ordinaryEligible,joinAvailability)
    ${select} WHERE ${where}
    ON CONFLICT(characterId) DO UPDATE SET payloadJson=excluded.payloadJson, classId=excluded.classId,
        level=excluded.level, clanId=excluded.clanId, ordinaryEligible=excluded.ordinaryEligible, joinAvailability=excluded.joinAvailability
    WHERE payloadJson IS NOT excluded.payloadJson OR classId IS NOT excluded.classId
        OR level IS NOT excluded.level OR clanId IS NOT excluded.clanId
        OR ordinaryEligible IS NOT excluded.ordinaryEligible
        OR joinAvailability IS NOT excluded.joinAvailability;`;

// The three triggers that compute a candidate's join availability from its
// life row; created by the recruitment upgrade and again when the row
// changes the columns they name.
function createAvailabilityTriggers(connection) {
    connection.exec(`
        CREATE TRIGGER bot_party_candidate_insert AFTER INSERT ON bot_life_state BEGIN
            ${insert('life.characterId = NEW.characterId')}
        END;
        CREATE TRIGGER bot_party_candidate_metadata AFTER UPDATE OF level,phase,partyId,activity,spotId ON bot_life_state BEGIN
            UPDATE ${table} SET level=NEW.level,joinAvailability=${availability('NEW', 'ordinaryEligible')}
            WHERE characterId=NEW.characterId
                AND (level IS NOT NEW.level OR joinAvailability IS NOT ${availability('NEW', 'ordinaryEligible')});
        END;
        CREATE TRIGGER bot_party_candidate_ordinary AFTER UPDATE OF ordinaryEligible ON ${table}
        WHEN OLD.ordinaryEligible IS NOT NEW.ordinaryEligible BEGIN
            UPDATE ${table} SET joinAvailability=(SELECT ${availability('life', 'NEW.ordinaryEligible')}
                FROM bot_life_state life WHERE life.characterId=NEW.characterId) WHERE characterId=NEW.characterId;
        END;
    `);
}

const statsTrigger = 'bot_party_candidate_stats';
// The payload and the identity flags of a candidate from its new stats, in one
// statement: separate triggers cannot share SQLite's JSON parse of the large
// document. classId, level and clanId stay with the other triggers.
function createStatsTrigger(connection) {
    connection.exec(`
        CREATE TRIGGER ${statsTrigger} AFTER UPDATE OF statsJson ON bot_life_state
        WHEN OLD.statsJson IS NOT NEW.statsJson BEGIN
            INSERT INTO ${table}(characterId,payloadJson,ordinaryEligible,joinAvailability)
            SELECT NEW.characterId, ${payload('NEW')}, ${ordinary('NEW')}, ${availability('NEW', `(${ordinary('NEW')})`)}
            FROM characters c WHERE c.id = NEW.characterId
            ON CONFLICT(characterId) DO UPDATE SET payloadJson=excluded.payloadJson,
                ordinaryEligible=excluded.ordinaryEligible, joinAvailability=excluded.joinAvailability
            WHERE payloadJson IS NOT excluded.payloadJson OR ordinaryEligible IS NOT excluded.ordinaryEligible
                OR joinAvailability IS NOT excluded.joinAvailability;
        END;
    `);
}

// The separate payload and identity triggers give way to the one stats trigger
// (worlds past the recruitment upgrade; younger ones already have it).
function mergeStatsTriggers(connection) {
    connection.exec(`
        DROP TRIGGER IF EXISTS bot_party_candidate_payload;
        DROP TRIGGER IF EXISTS bot_party_candidate_identity;
        DROP TRIGGER IF EXISTS ${statsTrigger};
    `);
    createStatsTrigger(connection);
}

// Every candidate row computed again from its life row (one pass).
function refreshCandidates(connection) {
    connection.exec(insert('1'));
}

function upgradeRecruitment(connection) {
    const updateOrdinary = id => `UPDATE ${table} SET ordinaryEligible = (
        SELECT ${ordinary('life')} FROM bot_life_state life INNER JOIN characters c ON c.id = life.characterId
        WHERE life.characterId = ${id}) WHERE characterId = ${id};`;
    connection.exec(`
        ALTER TABLE ${table} ADD COLUMN classId INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ${table} ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE ${table} ADD COLUMN clanId INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ${table} ADD COLUMN joinAvailability INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ${table} ADD COLUMN ordinaryEligible INTEGER NOT NULL DEFAULT 0;
        DROP TRIGGER bot_party_candidate_insert;
        DROP TRIGGER bot_party_candidate_payload;
    `);
    refreshCandidates(connection);
    connection.exec(`
        CREATE INDEX bot_party_candidate_recruitment
            ON ${table}(joinAvailability,clanId,classId,level,characterId);
        CREATE TRIGGER bot_party_candidate_account AFTER UPDATE OF accountName ON bot_life_state
        WHEN OLD.accountName IS NOT NEW.accountName BEGIN ${updateOrdinary('NEW.characterId')} END;
        CREATE TRIGGER bot_party_candidate_character AFTER UPDATE OF classId,clanId ON characters
        WHEN OLD.classId IS NOT NEW.classId OR OLD.clanId IS NOT NEW.clanId BEGIN
            UPDATE ${table} SET classId=COALESCE(NEW.classId,0),clanId=COALESCE(NEW.clanId,0) WHERE characterId=NEW.id;
        END;
        CREATE TRIGGER bot_party_candidate_username AFTER UPDATE OF username ON characters
        WHEN OLD.username IS NOT NEW.username BEGIN ${updateOrdinary('NEW.id')} END;
    `);
    createStatsTrigger(connection);
    createAvailabilityTriggers(connection);
}

module.exports = { install, createIndex, upgradeRecruitment, createAvailabilityTriggers, mergeStatsTriggers, refreshCandidates };
