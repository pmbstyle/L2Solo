// A small JSON read model, updated atomically by every state writer. Eligibility
// and ownership remain in the authoritative life row's covering index.
const paths = ['$.role', '$.generatedIndex', '$.partyRequest', '$.clanPartyObjective', '$.equipmentPlan', '$.partyHistory'];
const table = 'bot_party_candidate_projection';

function install(connection) {
    // One parse of the large document per update, not one per projected field.
    const payload = prefix => `json_extract(${prefix}.statsJson, ${paths.map(path => `'${path}'`).join(', ')})`;
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
        DROP INDEX IF EXISTS bot_life_state_party_candidate_projection;
        CREATE INDEX bot_life_state_party_candidate_projection ON bot_life_state(
            simulationOwner, phase, partyId, activity, partyObjectiveSpot,
            partyRequestStatus, partyRequestPriority, updatedAt, level,
            characterId, characterName, activityStartedAt, simulationRevision, spotId
        );
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

module.exports = { install };
