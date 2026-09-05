// Player-facing English speech. Keep facts in {placeholders}; callers supply
// them only after the corresponding game event. Do not imply equipped gear,
// successful delivery, or a sold-out offer from a purchase attempt alone.
// Edit variants here; eligibility, priorities and cooldowns live in callers.
// Dialogue entries with { when, yes, no } choose a line using a caller flag.
const catalog = {
    "town.equipment-market-selected": [
        "Might be worth checking {seller} for {item}.",
        "{seller}'s price for {item} looks better. I'll take a look.",
        "Going to have a look at {seller}'s {item}."
    ],
    "town.warehouse-not-in-town": [
        "Can't find a warehouse here. I'll hang on to the good stuff.",
        "No luck with storage. The valuables are staying with me."
    ],
    "town.warehouse-selected": [
        "Dropping a few things off with {merchant} before I shop.",
        "I'll leave the good stuff with {merchant}, then clear out my bag."
    ],
    "town.shopping-cancelled": [
        "Shopping can wait. Staying with the party.",
        "I'll leave the shopping for later and stick with you.",
        "Never mind the shops \u2014 staying with the group.",
        "I'll handle the errands next time we're in town."
    ],
    "town.buyer-selected": [
        "Taking this loot to {merchant} in {town}.",
        "{merchant} is buying, so I'll sell there.",
        "Found a player buyer in {town}: {merchant}."
    ],
    "town.buyer-selected.player": [
        "Taking this loot to {merchant} in {town}.",
        "{merchant} is buying, so I'll sell there.",
        "Found a buyer in {town}: {merchant}.",
        "I'll see what {merchant} offers for this haul."
    ],
    "town.npc-seller-unavailable": [
        "Can't find anyone to sell this lot to. I'll try again later.",
        "No luck with the shops. Guess I'm carrying this a little longer."
    ],
    "town.npc-seller-selected": [
        "I'll see what {merchant} in {town} will give me for this lot.",
        "No luck finding a buyer. Off to {merchant}'s shop in {town}."
    ],
    "town.alternate-warehouse": [
        "Can't get to {merchant}. I'll try {alternate}.",
        "I'll leave this with {alternate} instead, if I can get through."
    ],
    "town.warehouse-unreachable": [
        "Can't get to the warehouse. I'll keep the valuables on me.",
        "I'll sort out storage another time. Keeping the good stuff."
    ],
    "town.alternate-equipment-shop": [
        "Can't get to {merchant}. Trying {alternate} instead.",
        "I'll have a look at {alternate}; no luck getting through here."
    ],
    "town.alternate-town-shop": [
        "Can't reach {merchant}. I'll try {alternate}.",
        "That way's blocked. Let's see if I can get to {alternate}."
    ],
    "town.shop-unreachable": [
        "I couldn't reach the shop. I'll retry later.",
        "Can't get through to the merchant. I'll retry later."
    ],
    "town.warehouse-deposit": [
        "Left {items} with {merchant}. A bit more room in my bag now.",
        "{merchant} is looking after {items} for me."
    ],
    "town.warehouse-unavailable": [
        "Couldn't leave this with {merchant}. I'll hang on to it.",
        "No luck putting this away. I'll try again later."
    ],
    "town.supply-purchased": [
        "Got your {item} \u2014 {count} of them. Heading back.",
        "Got the {item}. On my way back to you.",
        "All right, {count} {item} in the bag. Coming back."
    ],
    "town.supply-purchase-failed.short-adena": [
        "I'm short on Adena for those supplies. Can you spare some?",
        "Couldn't afford the full order. I'll need a little more Adena."
    ],
    "town.supply-purchase-failed.unavailable": [
        "Couldn't get those supplies. I'm heading back.",
        "No luck with the purchase. Coming back empty-handed."
    ],
    "town.market-gear-purchased": [
        "Got myself {item}. That should help.",
        "{seller} had {item}, so I picked it up.",
        "Well, there goes some Adena. Got {item}, though.",
        "Picked up {item} from {seller}. Looking forward to trying it."
    ],
    "town.market-offer-gone": [
        "Couldn't get that offer. I'll keep looking.",
        "No luck buying that one. I'll check again later."
    ],
    "town.npc-gear-purchased": [
        "Got myself {item}. That should help.",
        "Found {item} at {seller}'s shop. Couldn't pass it up.",
        "All right, got {item}. Let's see how it does.",
        "Picked up {item} from {seller}. Worth the trip."
    ],
    "town.npc-gear-purchase-failed.short-adena": [
        "That gear's a bit beyond my budget. For now.",
        "Found something I like, but I can't afford it yet.",
        "A little more Adena and I can think about that upgrade."
    ],
    "town.npc-gear-purchase-failed.unavailable": [
        "Couldn't buy that one. I'll try again later.",
        "No luck getting the gear this time."
    ],
    "town.loot-sold": [
        "{buyer} took {items} off my hands. Made {adena} Adena.",
        "Got {adena} Adena for {items}. Thanks, {buyer}."
    ],
    "town.shots-too-expensive": [
        "Can't afford more {item} yet.",
        "{item} would cost {cost} Adena. I've only got {adena}.",
        "A bit short for {item}. I'll have to make do for now."
    ],
    "town.shots-restocked": [
        "Got another {count} {item}. That should last a bit.",
        "Picked up some {item}. There goes {cost} Adena.",
        "Got the shots. Ready for another run."
    ],
    "town.shots-already-stocked": [
        "Still got plenty of {item}.",
        "No need for more shots just yet."
    ],
    "town.healing-potions-restocked": [
        "Got {count} {item}, just in case.",
        "Picked up some {item}. Better to have them and not need them."
    ],
    "town.shopping-to-rebuff": [
        "Done shopping. Quick stop at the Newbie Guide before I go.",
        "Got what I need. Just getting fresh buffs."
    ],
    "town.return-to-party": [
        "All set. On my way back.",
        "Done in town. Coming back to you.",
        "That's the errands out of the way. Heading back."
    ],
    "town.supply-return.ready": [
        "Back with your supplies. I'll trade them over when it's safe.",
        "Got the goods here. Let's wait for a quiet moment to trade."
    ],
    "town.supply-return.empty": [
        "I'm back. Sorry, couldn't get the supplies.",
        "Back, but empty-handed this time."
    ],
    "town.newbie-guide-unreachable": [
        "Can't get to the Newbie Guide. I'll retry later.",
        "No luck reaching the guide. I'll retry later."
    ],
    "town.newbie-blessing-complete.party": [
        "Got my buffs. Heading back to you.",
        "All buffed up. On my way back."
    ],
    "town.newbie-blessing-complete.solo": [
        "Fresh buffs. Let's give it another go.",
        "All right, ready to head out."
    ],
    "town.shopping-deferred": [
        "Staying with the party. I can sell the loot later.",
        "The bag can wait; I'm not leaving the group for shopping.",
        "Skipping the town run for now and keeping up with the party.",
        "I'll handle the loot on our next town stop."
    ],
    "town.town-to-farm": [
        "Done in town. Off to {place}.",
        "Got what I need. Heading for {place}."
    ],
    "town.farm-relocation": [
        "Going to try {place} for a bit.",
        "Let's see how things are around {place}.",
        "Off to {place}."
    ],
    "town.heading-to-newbie-guide.in-town": [
        "Might as well get fresh buffs while I'm here.",
        "Quick stop at the Newbie Guide, then I'm off."
    ],
    "town.heading-to-newbie-guide.expired": [
        "Buffs wore off. Time to find the Newbie Guide.",
        "Could use fresh buffs before the next run."
    ],
    "town.town-trip-start": [
        "Quick trip to {town}. A few things to take care of.",
        "Heading into {town} for supplies. Back after that.",
        "Off to {town} for a bit."
    ],
    "combat.foundTarget": [
        "Let's try that {target}.",
        "That {target} looks manageable.",
        "All right, {target}. Your turn.",
        "Maybe just one more {target}."
    ],
    "combat.victory": [
        "That will do.",
        "Getting the hang of this.",
        "One less thing trying to kill me.",
        "Right. Next?"
    ],
    "combat.hurt": [
        "Ouch! That {target} hits hard!",
        "Could use a heal!",
        "Getting a bit low here.",
        "Heal me, please!"
    ],
    "combat.revived": [
        "Right. Trying that again.",
        "Maybe a little more carefully this time.",
        "That was an expensive lesson.",
        "Still here. Mostly."
    ],
    "combat.death": [
        "Well, that went badly."
    ],
    "combat.rest": [
        "Need a breather."
    ],
    "combat.rested": [
        "Right, one more try."
    ],
    "dialogue.rest.1": [
        "You heading out again soon?",
        {
            "when": "cautious",
            "yes": "In a bit. No point going back half ready.",
            "no": "Trying to convince myself to get up."
        },
        "Yeah, this is how a quick break turns into an evening."
    ],
    "dialogue.rest.2": [
        "Taking a break around {place} too?",
        "Yep. Giving my legs a chance to forgive me.",
        "Let me know if that works."
    ],
    "dialogue.roads.1": [
        "Why does the walk back always feel twice as long?",
        "You can see the shops at the end of it. That makes it worse.",
        "Fair point. I should stop looking at prices."
    ],
    "dialogue.roads.2": [
        "I swear I spend half my time walking.",
        "The other half is deciding where to walk.",
        "Do not remind me."
    ],
    "dialogue.gear.1": [
        "Saving for a weapon or armor first?",
        {
            "when": "cautious",
            "yes": "Armor. I like making it back in one piece.",
            "no": "Weapon. I am getting impatient."
        },
        {
            "when": "cautious",
            "yes": "Sensible. I keep talking myself out of the sensible option.",
            "no": "Yeah, shiny weapons are hard to argue with."
        }
    ],
    "dialogue.gear.2": [
        "Every upgrade makes the next one look more expensive.",
        "Best not to look at the next one yet.",
        "A bit late for that advice."
    ],
    "dialogue.company.1": [
        "Mind if I sit here a while?",
        {
            "when": "social",
            "yes": "Please do. Beats staring at the road alone.",
            "no": "Go ahead. I am not moving for a bit."
        },
        "Good. Neither am I."
    ],
    "dialogue.company.2": [
        "Ever say \"one more run\" and actually mean it?",
        {
            "when": "social",
            "yes": "Only when someone drags me back to town.",
            "no": "I prefer not to count."
        },
        "That sounds suspiciously familiar."
    ],
    "dialogue.hunting.1": [
        "Easy mobs or a bit of a challenge?",
        {
            "when": "cautious",
            "yes": "Easy. A boring run still pays.",
            "no": "A challenge. Within reason."
        },
        {
            "when": "cautious",
            "yes": "Hard to argue with a run you actually survive.",
            "no": "\"Within reason\" does a lot of work there."
        }
    ],
    "dialogue.hunting.2": [
        "How long before you get tired of the same hunting spot?",
        {
            "when": "social",
            "yes": "Depends who is there. Good company helps.",
            "no": "Usually right before it finally gets good."
        },
        "So it is not just me, then."
    ],
    "dialogue.party.1": [
        "What keeps you busy in a group?",
        "{reply}",
        "Sounds like you have your hands full."
    ],
    "dialogue.trade.1": [
        "Next town trip, remind me not to stare at every shop.",
        "That is a lot of responsibility to put on someone doing the same thing.",
        "Fine. We are both hopeless."
    ],
    "dialogue.recovery.1": [
        "Still waiting on mana?",
        "Yeah. It is taking its time.",
        "No rush. I could use a minute too."
    ],
    "dialogue.role.healer": [
        "When people stop watching their health, I have to watch it for them."
    ],
    "dialogue.role.buffer": [
        "Everyone remembers buffs about two steps after leaving town."
    ],
    "dialogue.role.tank": [
        "Mostly trying to keep the mobs looking at me."
    ],
    "dialogue.role.archer": [
        "Keeping my distance. Ideally more than the mobs would like."
    ],
    "dialogue.role.dagger": [
        "Getting behind things. Easier said than done."
    ],
    "global.death": [
        "Well, that pull was a mistake.",
        "Back to town the hard way. Should have backed off.",
        "So much for \"just one more mob\".",
        "Anyone else getting a little too brave today? I just paid for it.",
        "That went badly. Taking a breather before round two."
    ],
    "global.break": [
        "Anyone else on a town break?",
        "One more run, then a break. Probably."
    ],
    "global.roads": [
        "Anyone actually enjoy the walk back to town?",
        "The trip back always feels longer, somehow."
    ],
    "global.patience": [
        "How do you lot stop yourselves checking every shop?",
        "Saving for gear is testing my patience."
    ],
    "global.company": [
        "Quiet out here. How is everyone doing?",
        "What is everyone working towards today?"
    ],
    "reaction.global.death": [
        "One of those runs, {name}?",
        "Let's call it a learning experience."
    ],
    "reaction.global.break": [
        "Taking it easy for a bit myself, {name}.",
        "Can't argue with that. No rush."
    ],
    "reaction.global.roads": [
        "{name}, the trick is not to think about how far you still have to walk.",
        "Too late. I have been thinking about nothing else."
    ],
    "reaction.global.patience": [
        {
            "when": "cautious",
            "yes": "{name}, I try not to look at anything I cannot afford.",
            "no": "{name}, I keep telling myself the next run will pay for it."
        },
        "Sounds familiar. Let me know when that starts working."
    ],
    "reaction.global.company": [
        {
            "when": "social",
            "yes": "Still around, {name}. Trying to make the next gear upgrade hurt less.",
            "no": "Just saving up for gear, {name}. Slowly."
        },
        "Yeah, those prices keep me busy too."
    ],
    "reaction.local.gear": [
        "Nice find, {name}. Going to try it out?",
        "Of course. Hopefully before I start looking at the next one."
    ],
    "reaction.local.price": [
        "{name}, shopping is a dangerous hobby.",
        "My purse certainly thinks so."
    ],
    "reaction.local.rest": [
        "Rough run, {name}?",
        "Just need a minute. I will be fine."
    ],
    "reaction.local.rested": [
        {
            "when": "cautious",
            "yes": "Take it steady this time, {name}.",
            "no": "Good luck out there, {name}."
        },
        "Thanks. I will try to make it back in one piece."
    ],
    "reaction.local.victory": [
        "Save some enthusiasm for the next one, {name}.",
        "No promises."
    ],
    "reaction.local.revived": [
        "Welcome back, {name}.",
        "Thanks. Hoping to stay upright a bit longer this time."
    ],
    "reaction.global.death.2": [
        "Ouch, {name}. Time for a less ambitious run?",
        "Maybe. My sense of ambition could use a rest."
    ],
    "reaction.global.break.2": [
        "You say that now, {name}. Then the next run starts looking tempting.",
        "I know. I am a terrible judge of when to stop."
    ],
    "reaction.global.roads.2": [
        "{name}, at least the walk gives your purse time to recover.",
        "Mine needs a much longer walk, apparently."
    ],
    "reaction.global.patience.2": [
        "I know that feeling, {name}. There is always something just out of reach.",
        "Exactly. Every time I save up, I spot something else."
    ],
    "reaction.global.company.2": [
        "Hanging in there, {name}. Taking things one run at a time.",
        "That sounds like a decent plan."
    ],
    "reaction.local.gear.2": [
        "That should keep you happy for a while, {name}.",
        "Until I see the next shiny thing, anyway."
    ],
    "reaction.local.gear.3": [
        "{name}, save some Adena for the shots too.",
        "Good point. This shopping habit is getting expensive."
    ],
    "reaction.local.price.2": [
        "I try not to look at my purse after shopping, {name}.",
        "Hard to ignore when there is so little in it."
    ],
    "reaction.local.rest.2": [
        "Take your time, {name}. The mobs can wait.",
        "Thanks, {responder}. They have had enough of me for a moment."
    ],
    "reaction.local.rested.2": [
        "Back for another round, {name}?",
        "Apparently I never learn."
    ],
    "reaction.local.victory.2": [
        "Getting confident there, {name}.",
        "Only a little. Probably."
    ],
    "reaction.local.revived.2": [
        "Still in one piece, {name}?",
        "Close enough. Thanks for asking."
    ]
};

function lines(key, values = {}, flags = {}) {
    if (!Object.hasOwn(catalog, key)) return [];
    const variants = catalog[key];
    return variants.map((variant) => {
        const template = typeof variant === 'string' ? variant : variant[flags[variant.when] ? 'yes' : 'no'];
        let complete = true;
        const text = template.replace(/\{(\w+)\}/g, (_match, name) => {
            if (values[name] === undefined || values[name] === null || values[name] === '') {
                complete = false;
                return '';
            }
            return String(values[name]).replace(/\s+/g, ' ').trim();
        });
        return complete ? text : '';
    }).filter(Boolean);
}

function line(key, values, flags) {
    const variants = lines(key, values, flags);
    return variants[Math.floor(Math.random() * variants.length)] || '';
}

module.exports = { catalog, lines, line };
