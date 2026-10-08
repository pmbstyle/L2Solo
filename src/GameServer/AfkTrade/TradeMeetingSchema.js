'use strict';
function install(db) {
    db.exec(`
        ALTER TABLE afk_trade_shops ADD COLUMN custodyPolicy INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE afk_trade_lines ADD COLUMN intentJson TEXT;
        ALTER TABLE afk_trade_lines ADD COLUMN intentRevision INTEGER NOT NULL DEFAULT -1;
        CREATE TABLE board_trade_participants (
            characterId INTEGER PRIMARY KEY REFERENCES characters(id),
            nextSequence INTEGER NOT NULL DEFAULT 1, meetingId INTEGER
        );
        CREATE TABLE board_trade_meetings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE,
            terms TEXT NOT NULL, actorA INTEGER NOT NULL REFERENCES characters(id),
            actorB INTEGER NOT NULL REFERENCES characters(id), seqA INTEGER NOT NULL, seqB INTEGER NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'accepted',
            town TEXT NOT NULL, locX REAL NOT NULL, locY REAL NOT NULL, locZ REAL NOT NULL,
            arrivalMask INTEGER NOT NULL DEFAULT 0, deliveryMask INTEGER NOT NULL DEFAULT 0,
            escrowA INTEGER NOT NULL DEFAULT 0, escrowB INTEGER NOT NULL DEFAULT 0,
            routeReserveA INTEGER NOT NULL DEFAULT 0, routeReserveB INTEGER NOT NULL DEFAULT 0,
            routeA TEXT NOT NULL, routeB TEXT NOT NULL,
            nextLegA INTEGER NOT NULL DEFAULT 1, nextLegB INTEGER NOT NULL DEFAULT 1,
            legA TEXT, legB TEXT, reason TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX board_trade_meetings_active ON board_trade_meetings(state,id);
        CREATE TABLE board_trade_meeting_lines (
            meetingId INTEGER NOT NULL REFERENCES board_trade_meetings(id), ordinal INTEGER NOT NULL,
            payer INTEGER NOT NULL, selfId INTEGER NOT NULL, enchant INTEGER NOT NULL,
            count INTEGER NOT NULL, price INTEGER NOT NULL, heldCount INTEGER NOT NULL,
            sourceObjectId INTEGER, name TEXT NOT NULL, slot INTEGER NOT NULL DEFAULT 0,
            stackable INTEGER NOT NULL DEFAULT 0, petData TEXT,
            sourceAdId INTEGER, sourceAdRevision INTEGER,
            custodyType TEXT NOT NULL DEFAULT 'trade', PRIMARY KEY(meetingId,ordinal)
        );
    `);
}
module.exports = { install };
