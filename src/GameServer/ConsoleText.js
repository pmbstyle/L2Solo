const ServerResponse = invoke('GameServer/Network/Response');

const ConsoleText = {
    caption: {
        depletedMp        :  24,
        depletedArrows    : 112,
        pickupAdenaAmount :  28,
        pickupAmountOf    :  29,
        pickup            :  30,
        welcome           :  34,
        actorHit          :  35,
        monsterHit        :  36,
        shootArrow        :  41,
        missedHit         :  43,
        criticalHit       :  44,
        used              :  46,
        equipped          :  49,
        earnedAdena       :  52,
        earnedAmountOf    :  53,
        earnedItem        :  54,
        earnedExpAndSp    :  95,
        levelUp           :  96,
        incorrectDest     : 144,
        magicResisted     : 159,
        waitForResponse   : 164,
        insufficientSp    : 278,
        insufficientAdena : 279,
        dropped           : 298,
        unequipped        : 417,
        loadLimitExceeded : 422,
        spoilActivated    : 612,
    },

    kind: {
        text   : 0,
        number : 1,
        npc    : 2,
        item   : 3,
        skil   : 4,
    },

    transmit(session, textId, params = []) {
        session.dataSendToMe(
            ServerResponse.consoleText(textId, params)
        );
    },

    transmitPickup(session, selfId, amount) {
        const item = { kind: ConsoleText.kind.item, value: selfId };
        const count = { kind: ConsoleText.kind.number, value: amount };
        if (amount > 1) {
            if (selfId === 57) ConsoleText.transmit(session, ConsoleText.caption.pickupAdenaAmount, [count]);
            else ConsoleText.transmit(session, ConsoleText.caption.pickupAmountOf, [item, count]);
        } else ConsoleText.transmit(session, ConsoleText.caption.pickup, [item]);
    }
};

module.exports = ConsoleText;
