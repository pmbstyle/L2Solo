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
        "One more run, then a break. Probably.",
        "How often do you lot take a breather?",
        "I keep saying five more minutes. You know how that goes.",
        "Tempted to call it a day. Also tempted to do one more run.",
        "A slow run still counts as a run, right?"
    ],
    "global.roads": [
        "Anyone actually enjoy the walk back to town?",
        "The trip back always feels longer, somehow.",
        "Do you save on gatekeepers or pay to skip the walk?",
        "All this walking had better be good for something.",
        "I swear the road gets longer when your bags are full.",
        "The gatekeeper prices make walking sound much more appealing."
    ],
    "global.patience": [
        "How do you lot stop yourselves checking every shop?",
        "Saving for gear is testing my patience.",
        "Anyone else spend longer choosing gear than actually using it?",
        "Every upgrade I want seems to cost just a bit more than I have.",
        "Trying to save adena. The shops are not helping.",
        "At what point do you stop browsing and just buy the damn thing?"
    ],
    "global.company": [
        "Quiet out here. How is everyone doing?",
        "What is everyone working towards today?",
        "How are the runs going today?",
        "Anyone making progress, or are we all just wandering around?",
        "What keeps you going: the next level or the next bit of gear?",
        "Still out there, everyone?"
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


// Each entry is [preferred voice, complete utterance]. Reply and close pools
// share a topic, but each turn is chosen using its own speaker's personality.
const voices = {
    'town.gear': [
        ['thrifty', 'Bought {item} from {seller}. Now it needs to earn its price.'],
        ['driven', 'Finally bought {item} from {seller}. Looking forward to trying it.'],
        ['careful', 'Picked up {item} from {seller}. Hope I chose well.'],
        ['social', 'Could not resist {item} at {seller}\'s shop.'],
        ['calm', 'Got {item} from {seller}. That will do for now.'],
        ['reserved', 'Bought {item}. Found it at {seller}\'s.']
    ],
    'town.price': [
        ['thrifty', 'Not paying that much for {item}.'],
        ['direct', '{item} at that price? No thanks.'],
        ['careful', 'Need a better price on {item}. I want something left in reserve.'],
        ['weary', 'Even {item} is too expensive today.'],
        ['calm', 'I can wait for a better deal on {item}.'],
        ['reserved', '{item} costs too much here.']
    ],
    'global.hunting': [
        ['careful', 'I would rather have a boring run than a messy one.'],
        ['daring', 'Ever get tempted to try a much harder hunting spot?'],
        ['driven', 'I keep wondering if there is a faster way to the next level.'],
        ['thrifty', 'A good hunting spot has to pay for the supplies.'],
        ['social', 'What makes a spot worth staying at for you?'],
        ['calm', 'A familiar spot suits me. I can settle into the run.']
    ],
    'reaction.global.hunting.reply': [
        ['careful', 'I like knowing I can get out if a pull goes wrong, {name}.'],
        ['daring', 'A little risk keeps it interesting, {name}.'],
        ['driven', 'I want to see that level moving, {name}.'],
        ['thrifty', 'It is the supply bill I watch, {name}.'],
        ['loyal', 'Depends who is there with you, {name}.'],
        ['reserved', 'Something I can manage alone, {name}.']
    ],
    'reaction.global.hunting.close': [
        ['careful', 'I would still rather leave a little room for mistakes.'],
        ['daring', 'I get restless when every pull feels the same.'],
        ['driven', 'Always feels like I could be making more progress.'],
        ['thrifty', 'No sense hunting all day just to pay for the shots.'],
        ['social', 'Good company makes even a familiar spot feel different.'],
        ['calm', 'As long as the run is going somewhere, I am happy.']
    ],
    'local.rest': [
        ['careful', 'Not risking another pull without a breather.'],
        ['driven', 'Quick break. Still plenty I want to get done.'],
        ['calm', 'Good time to sit down for a bit.'],
        ['weary', 'That took more out of me than I expected.'],
        ['social', 'Anyone else need a minute?'],
        ['reserved', 'Need a breather.']
    ],
    'local.rested': [
        ['careful', 'Ready. Keeping the next pulls manageable.'],
        ['driven', 'Right. Back to making progress.'],
        ['calm', 'That helped. Ready for another run.'],
        ['daring', 'All right, let us see what I can take.'],
        ['social', 'Back at it. See you around!'],
        ['reserved', 'Ready again.']
    ],
    'local.victory': [
        ['careful', 'Good. Still keeping an eye on the next pull.'],
        ['driven', 'That is the pace I wanted.'],
        ['calm', 'Happy with that one.'],
        ['daring', 'Could probably handle a bit more.'],
        ['social', 'There we go!'],
        ['reserved', 'Done.']
    ],
    'local.revived': [
        ['careful', 'Back. Getting properly ready before I head out.'],
        ['driven', 'Still have a level to chase.'],
        ['calm', 'Fresh start. No point dwelling on it.'],
        ['weary', 'Really do not want to do that again.'],
        ['social', 'Still here, somehow.'],
        ['reserved', 'Back on my feet.']
    ],
    'global.death': [
        ['calm', 'Bad pull. It happens.'],
        ['weary', 'Ugh. All that running, and I still ended up dead.'],
        ['careful', 'Should have left myself a way out of that pull.'],
        ['daring', 'That was one mob too many. Nearly had it, though.'],
        ['direct', 'Fine. That pull was my fault.'],
        ['social', 'Anyone else finding out their limits the painful way? I just did.'],
        ['reserved', 'Dead. Not my best run.'],
        ['driven', 'Lost that round. Still want to get it right.']
    ],
    'global.break': [
        ['social', 'Anyone else taking it slow today?'],
        ['reserved', 'Some days a quiet run is enough.'],
        ['careful', 'A short break beats making a stupid mistake.'],
        ['driven', 'I never know when to stop. There is always another level to chase.'],
        ['calm', 'No hurry today. The mobs will still be there.'],
        ['weary', 'How do people keep going for hours?'],
        ['daring', 'Taking it easy sounds good until the next pull.'],
        ['warm', 'Hope you lot are remembering to take a breather.']
    ],
    'global.roads': [
        ['thrifty', 'Gatekeeper or walking? My purse always votes walking.'],
        ['driven', 'Wish the walk back counted towards the next level.'],
        ['calm', 'I do not mind the roads. Gives me time to think.'],
        ['weary', 'The road back to town never seems to end.'],
        ['social', 'What do you lot do to make the long walks less boring?'],
        ['reserved', 'Long walks. At least they are quiet.'],
        ['careful', 'A familiar road beats an exciting shortcut.'],
        ['daring', 'Half the fun of a shortcut is finding out if it was a terrible idea.']
    ],
    'global.patience': [
        ['thrifty', 'The trick to saving adena is apparently never looking at shops.'],
        ['driven', 'Every upgrade just makes me want the next one.'],
        ['careful', 'I spend more time comparing gear than buying it.'],
        ['social', 'Anyone else have a shopping list longer than their purse can handle?'],
        ['reserved', 'Good gear. Bad prices.'],
        ['weary', 'Everything worth buying seems just out of reach.'],
        ['calm', 'A little closer to decent gear each run. That will do.'],
        ['direct', 'Cheap is only a bargain if you actually use it.']
    ],
    'global.company': [
        ['social', 'How is everyone doing out there?'],
        ['warm', 'Hope the runs are treating you lot well today.'],
        ['loyal', 'A good regular party is worth more than a perfect hunting spot.'],
        ['reserved', 'Still people out there?'],
        ['driven', 'What are you all chasing next: a level or new gear?'],
        ['thrifty', 'Anyone else measuring progress by the adena left after supplies?'],
        ['calm', 'Some days just making a little progress is enough.'],
        ['direct', 'Good company makes even a slow run worthwhile.']
    ],
    'reaction.global.death.reply': [
        ['warm', 'Ouch, {name}. Happens to everyone.'],
        ['careful', '{name}, leave yourself an escape route next time.'],
        ['direct', 'Smaller pulls, {name}. You cannot spend adena while dead.'],
        ['calm', 'One bad run, {name}. You will get it back.'],
        ['daring', 'At least you found the limit, {name}.'],
        ['reserved', 'Rough one, {name}.']
    ],
    'reaction.global.death.close': [
        ['calm', 'Yeah. One bad run is not the end of it.'],
        ['weary', 'I know. Just annoyed with myself.'],
        ['careful', 'Going to give those pulls a little more room.'],
        ['driven', 'Still want another go. With a better plan.'],
        ['warm', 'Thanks, {responder}. Needed to hear another voice.'],
        ['reserved', 'Yeah. Lesson learned.']
    ],
    'reaction.global.break.reply': [
        ['social', 'Same problem here, {name}. Always one more thing to do.'],
        ['warm', 'Go at your own pace, {name}.'],
        ['driven', '{name}, the next level is a pretty good reason to keep going.'],
        ['calm', 'Nothing wrong with a slow day, {name}.'],
        ['careful', 'Tired runs get expensive, {name}.'],
        ['reserved', 'No rush, {name}.']
    ],
    'reaction.global.break.close': [
        ['driven', 'That next level is hard to put out of my head.'],
        ['calm', 'I will see how I feel. No need to force it.'],
        ['weary', 'My enthusiasm could use a refill.'],
        ['social', 'Glad I am not the only one thinking about this.'],
        ['careful', 'Better to stop before the stupid mistakes start.'],
        ['reserved', 'We will see.']
    ],
    'reaction.global.roads.reply': [
        ['thrifty', '{name}, I just think about the adena I am saving.'],
        ['social', 'Talking makes the road shorter, {name}. Well, almost.'],
        ['calm', 'I like a bit of quiet between runs, {name}.'],
        ['direct', 'Time is worth something too, {name}.'],
        ['careful', 'Getting there in one piece is good enough for me, {name}.'],
        ['reserved', 'Plenty of time to think, {name}.']
    ],
    'reaction.global.roads.close': [
        ['thrifty', 'Still cannot talk myself into paying for every trip.'],
        ['driven', 'I would rather spend that time hunting.'],
        ['social', 'At least the chat keeps the road interesting.'],
        ['calm', 'Could be worse. There is no rush.'],
        ['weary', 'Still feels like I spend half my life on the road.'],
        ['careful', 'I will take a dull trip over a nasty surprise.']
    ],
    'reaction.global.patience.reply': [
        ['thrifty', '{name}, I compare the price with how many runs it will cost me.'],
        ['driven', 'The upgrade is the point, {name}. Something to work for.'],
        ['warm', 'You will get there, {name}. Bit by bit.'],
        ['careful', 'Keep enough for supplies, {name}. Shiny gear can wait.'],
        ['calm', 'No need to buy it all today, {name}.'],
        ['direct', 'Buy what makes the next run better, {name}. Ignore the rest.']
    ],
    'reaction.global.patience.close': [
        ['thrifty', 'I want to like the price as much as the item.'],
        ['driven', 'Once I get this upgrade, the next one will start bothering me.'],
        ['careful', 'I should probably leave myself a supply budget.'],
        ['calm', 'I can wait. It gives me something to aim for.'],
        ['weary', 'Would be nice to afford something without doing the sums first.'],
        ['social', 'Good to know I am not the only one counting every adena.']
    ],
    'reaction.global.company.reply': [
        ['social', 'Still here, {name}. Always glad of a bit of chat.'],
        ['reserved', 'Still going, {name}.'],
        ['warm', 'Hope your runs go well too, {name}.'],
        ['driven', 'Another level is the plan, {name}. Then probably another.'],
        ['thrifty', 'Trying to finish richer than I started, {name}.'],
        ['loyal', 'Good people make the runs worth it, {name}.']
    ],
    'reaction.global.company.close': [
        ['social', 'Good to hear from someone out there.'],
        ['reserved', 'Good luck with it.'],
        ['warm', 'Hope it goes your way, {responder}.'],
        ['driven', 'Back to making some progress, then.'],
        ['calm', 'One run at a time. That works for me.'],
        ['loyal', 'People you can rely on make a difference.']
    ],
    'reaction.local.gear.reply': [
        ['warm', 'Nice find, {name}. Hope it serves you well.'],
        ['thrifty', '{name}, did you leave anything in the purse for supplies?'],
        ['driven', 'Now put it to work, {name}.'],
        ['careful', 'Try it on something manageable first, {name}.'],
        ['social', 'All right, {name}! Nothing like a new bit of gear.'],
        ['reserved', 'Looks useful, {name}.']
    ],
    'reaction.local.gear.close': [
        ['thrifty', 'Going to make it earn its price.'],
        ['driven', 'Looking forward to putting it through a few runs.'],
        ['careful', 'I will get a feel for it before trying anything ambitious.'],
        ['social', 'Probably going to stare at it for another minute first.'],
        ['warm', 'Thanks, {responder}. Hope it was a good choice.'],
        ['reserved', 'We will see how it does.']
    ],
    'reaction.local.price.reply': [
        ['thrifty', 'Walk away, {name}. There will be another seller.'],
        ['careful', 'Keep a little in reserve, {name}.'],
        ['warm', 'Yeah, {name}. Supplies can really eat into a run.'],
        ['direct', 'A bad price is a bad price, {name}.'],
        ['calm', 'No hurry to buy, {name}.'],
        ['reserved', 'Not worth it, {name}.']
    ],
    'reaction.local.price.close': [
        ['thrifty', 'Going to compare a few more prices.'],
        ['driven', 'I want to get back to hunting, but not at any price.'],
        ['careful', 'I would rather keep a reserve than empty my purse.'],
        ['weary', 'Feels like every seller has the same idea today.'],
        ['calm', 'I can wait for a better deal.'],
        ['reserved', 'I will look elsewhere.']
    ],
    'reaction.local.rest.reply': [
        ['warm', 'Take your time, {name}. No need to rush.'],
        ['careful', 'Better a break than another trip back dead, {name}.'],
        ['driven', 'Catch your breath, {name}. Plenty left to do.'],
        ['calm', 'The mobs can wait, {name}.'],
        ['social', 'Even the quiet part of a run is better with company, {name}.'],
        ['reserved', 'Rough run, {name}?']
    ],
    'reaction.local.rest.close': [
        ['warm', 'Thanks, {responder}. A minute should help.'],
        ['careful', 'Not going back half ready.'],
        ['driven', 'Just catching my breath. I still have work to do.'],
        ['calm', 'Quite happy to sit here for a bit.'],
        ['weary', 'Might need more than a minute, honestly.'],
        ['reserved', 'I will be fine.']
    ],
    'reaction.local.rested.reply': [
        ['warm', 'Good luck out there, {name}.'],
        ['careful', 'Take it steady, {name}.'],
        ['driven', 'Make the next run count, {name}.'],
        ['daring', 'Go give them something to worry about, {name}.'],
        ['social', 'See you around, {name}!'],
        ['reserved', 'Safe travels, {name}.']
    ],
    'reaction.local.rested.close': [
        ['warm', 'Thanks. You too, {responder}.'],
        ['careful', 'Keeping an eye on the way out this time.'],
        ['driven', 'Time to get something done.'],
        ['daring', 'No promises about taking it easy.'],
        ['calm', 'We will see what the next run brings.'],
        ['reserved', 'Thanks.']
    ],
    'reaction.local.victory.reply': [
        ['warm', 'Nicely done, {name}.'],
        ['careful', 'Do not let it go to your head, {name}.'],
        ['driven', 'Keep that up, {name}.'],
        ['daring', 'Bet you could handle a bit more, {name}.'],
        ['social', 'There you go, {name}!'],
        ['reserved', 'Clean work, {name}.']
    ],
    'reaction.local.victory.close': [
        ['warm', 'Thanks, {responder}.'],
        ['careful', 'One good fight. Still watching the next pull.'],
        ['driven', 'That is more like it.'],
        ['daring', 'Starting to wonder what else I can take.'],
        ['calm', 'Happy with that one.'],
        ['reserved', 'Worked out.']
    ],
    'reaction.local.revived.reply': [
        ['warm', 'Good to see you upright, {name}.'],
        ['careful', 'Give yourself a moment before heading out, {name}.'],
        ['calm', 'Fresh start, {name}.'],
        ['direct', 'Try a different pull this time, {name}.'],
        ['social', 'Welcome back, {name}!'],
        ['reserved', 'Back with us, {name}.']
    ],
    'reaction.local.revived.close': [
        ['warm', 'Thanks, {responder}. Glad to be back.'],
        ['careful', 'Taking a moment to get ready first.'],
        ['calm', 'No point dwelling on it.'],
        ['driven', 'Still have a level to work towards.'],
        ['weary', 'Would really like to avoid doing that again.'],
        ['reserved', 'Still here.']
    ]
};

voices['local.death'] = voices['global.death'];

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

module.exports = { catalog, voices, lines, line };
