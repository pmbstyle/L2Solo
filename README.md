<a href="https://l2solo.com">
<img alt="Lineage2 Solo local server" src="https://github.com/user-attachments/assets/feaccb0c-2d3b-4c47-a3b0-79b40ca0e7a5" />
</a>


# L2Solo (C4: Scions of Destiny)

Old-school Lineage 2 solo play, locally in a live world with over 1700 bot population.

L2Solo is a local-first Lineage II C4 server emulator, tuned for a solo MMO experiment: one real player, a live world, and bots with AI that makes the server feel alive.
Nothing is auto-generated. Everything in the world is the result of a player's or a bot's actions.

**Project status:** PUBLIC BETA

🏗️ Work in progress. Playable.


💬 [Discord](https://discord.gg/dXsQ8SJA7k)
Support, updates, and communication. Join the Discord to stay up to date with development.

⚔️ [Game client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing)
Clean C4 client protocol 656

🧩 [L2Solo client mod](https://drive.google.com/file/d/16snZK_8KQOzGfgEO6hmAoXOtkL4iMhM8/view?usp=sharing)
Optional but recommended for a better experience


💻 Simulation - everything that is happening in the game world besides player actions.

🧊 Cold bots - bots in the background, everywhere on the server where the player cannot see. Works like a less detailed simulation but keeps base bot abilities, stats, and goals, including cold bot parties, clans, etc. Bots become cold when goes out of the player's view range. Can communicate, including with the player (optional LLM integration). Uses much less compute.

🔥 Hot bots - bots that the player can see, or within maximum client view range. Any cold bot can become hot if the player is nearby. Highest detail level, uses much more compute for realistic movement, actions, etc.

🌳 Static bots - static traders in towns and crafting stations in Giran. Needed only for a specific function, no brain, no communication or goals.


## Latest updates
- **2026-11-09** Shot production and recipe supply, bot recovery, inventory and cross-floor combat fixes, Windows launcher updates
- **2026-11-08** Bug fixes, bot progression, garden of eva doors, launcher update
- **2026-11-07** L2Solo launcher, server and bot progression optimization, bug fixes
- **2026-10-30** Clan wars, geodata, bug fixes
- **2026-10-26** Server stability, better AI, spoil, hunting, bug fixes
- **2026-10-18** A living world economy, market board, better bot progression
- **2026-10-03** Bot and performance fixes, player-led raids, better observer, quests and more
- **2026-09-29** Market, recipes, bot shoulshots craft, paid buffs, fixes and improvements
- **2026-09-26** Bot raid boss farm, player bot party join, SA, fixes and updates
- **2026-09-22** Bot progression, clan party, craft, trading fixes; realistic bot and clan names
- **2026-09-21** L2Solo client mod, server-side mod support, in-game items db
- **2026-09-20** Clan halls, clan craft goals, clan WH resources collection, fixes and improvements
- **2026-09-17** Death exp penalties, overhit bonus, max level setting, bot lucky protection
- **2026-09-17** Gameplay fixes, clan progression, skills, and town services
- **2026-09-14** Better class-specific bot gameplay, fixes, and improvements
- **2026-09-12** Bot persistent social memory and hot/cold PvP
- **2026-09-08** Pets, striders, clan lvl 4, fixes and updates
- **2026-09-06** Bot PvP, save game, save TP location, optimization, chat, navigation
- **2026-09-04** Player clan warehouse use for equipment exchange, bug fixes
- **2026-09-02** AFK trade, market observer, xN mob fix
- **2026-08-31** Expand bot world simulation, arena duels, and server knowledge tools
- **2026-08-28** Skills, bot behavior, gear planning, and seeder fixes and improvements

<details>
<summary>Earlier</summary>

- **2026-08-27** Add LLM-driven clan management
- **2026-08-26** Observer update, better and faster, player clan crest control, player clan goal control
- **2026-08-25** Bot clans update follow-up, bug fixes
- **2026-08-24** Bot clans, better cold/hot performance, bug fixes, and more
- **2026-08-20** Loot and mob skills bug fixes, bot social graph base
- **2026-08-19** Runtime optimization, cold bot progression bottlenecks fix, bot equipment enchantment
- **2026-08-18** Fixes, cold bots progression, better AI compatibility
- **2026-08-17** Fix cold bot progression, melee and polearm attack range, raid minion party fear
- **2026-08-16** Summoners, BD, SWS, agro skills and Observer update
- **2026-08-15** Blade Dancers and Sword Singers bot progression update
- **2026-08-15** Raid Encounter and Gameplay Stability Update
- **2026-08-15** Server stability and performance update
- **2026-08-13** Fix hot party performance issues, fix raid boss attack freeze
- **2026-08-13** Raid bosses, better bot progression and market use, skill fixes, party finder update
- **2026-08-11** Expand C4 world content and bot progression systems
- **2026-08-09** Expand C4 world content and runtime fidelity

</details>

See the full update log on our [Discord](https://discord.gg/dXsQ8SJA7k) server.

## Game Checklist

### ✅ What's done

**Server:**
- Server launcher
- Authentication: create account, login (C4 client, protocol 656)
- Character creation
- Variable server rates for each server start: (x1/x10/x50) XP, SP, party XP/SP, drop/adena/spoil multipliers
- Real-time player web map that shows bots and players
- Partial or full wipe anytime

**World:**
- Complete geodata for all locations
- Complete live economy
- Teleports via NPC or .admin menu
- Live world / local / party / trade chats
- NPC shops in towns
- Profession change (first to third)
- Auto-learn skills (no books or NPC needed)
- Quests (0-20lvl + 1st profession change)
- Private trade or craft
- Clans, including bot clans
- PK system
- Save game
- Clan halls
- SA

**Character:**
- Progression depending on chosen rates
- Full C4 skill coverage: self, targeted, AoE, effects, items, and class skills
- Potions, scrolls, spoil, SA, manor, etc
- Party with bots with native (/invite, /leave), plus `.botparty` / `.bp` to find bots and invite them to the party
- All armor sets
- Soulshots/Spiritshots
- Death, respawn

**Mobs:**
- Attack
- Skill usage
- Drop table (scales from server rates)
- Social agro
- AoE agro
- Party loot
- Raid bosses

**Bots:**
- Dynamic bot population with a smart new bot seeding up to 1700
- Bots are farming solo and in party
- In-party roles (tank, dps, healer, buffer, etc)
- In-party buff control
- Bot goals: equipment craft/drop/purchase, gain wealth, lvl-up faster, etc
- Craft using recipes and craft stations
- Selling loot in towns using a private store
- Buying needed resources or equipment
- PK bots
- Bots attack a PK or run away
- Bots will argue, then attack if a bot or a player hits the same mob
- Communication in chat (LFP, LFG, PK alert, etc)
- Cost parties and friends system
- Reputation system - bots will reject player party if you treat them badly or become friends and const party members if good
- Bots ask for loot if you have something they need
- Bots go for NPC (Nobie guide) buff
- Bots change their farming location based on lvl, number of mobs around, or a crafting goal
- Bots join and fight in a party with a player
- Bots have a memory about interaction with a player; they act correspondingly 
- Bot persona traits: Sociability, Commitment, Caution, Ambition, Assertiveness, Empathy, Resilience
- Bots create clans, level clans up, form clan farm parties
- Bots will fight over mobs on a farm spot
- Bot clans can form raid boss farm parties
- Queen Ant, Core and Orfen have C4 stats, scripted guards/healers, Orfen's retreat and pull, and epic jewelry drops. Player parties and autonomous clans fight them through native actors, including without a nearby player. These three bosses have no +8 Raid Curse limit; C4 deep-blue drop penalties still apply. The server's shared raid stat reduction and ordinary loot rates also apply. Epic jewelry keeps its 30% single-item roll independently of the leveling preset (`General.epicDropChanceRate`, default 1).
- Their C4 respawn windows are 36 ± 17, 60 ± 23 and 48 ± 20 hours respectively. Queen Ant's ring, Core's ring and Orfen's earring are available in the admin shop; wearing two copies grants the passive once.
- Players can join bot parties
- Clan wars, including autonomous clan wars

### ✴️ Will be added

- Olympiad, heroes
- Sieges (bot- or player -driven)
- World bosses
- Full quests, including profession change
- Better bot AI brain
- Complete Lineage 2 C4 experience

<p align="center">
<img src="https://github.com/user-attachments/assets/ddb9c791-63ef-4c9f-861a-be822340a866" />


<img src="https://github.com/user-attachments/assets/99695c45-80e8-4300-afa6-cada58ccd3bd" />
</p>

## 🎮 Download L2Solo launcher

👉 **[Download the latest release](https://github.com/pmbstyle/L2Solo/releases/latest)**

<!-- STABLE_DOWNLOADS -->
| Platform | Download |
|----------|----------|
| **Windows** | [L2Solo-Launcher-0.2.3-windows-x64-Setup.exe](https://github.com/pmbstyle/L2Solo/releases/download/server-v0.1.2/L2Solo-Launcher-0.2.3-windows-x64-Setup.exe) |
| **macOS** | [L2Solo-Launcher-0.2.3-mac-arm64.dmg](https://github.com/pmbstyle/L2Solo/releases/download/server-v0.1.2/L2Solo-Launcher-0.2.3-mac-arm64.dmg) |
| **Linux** | [L2Solo-Launcher-0.2.3-linux-x86_64.AppImage](https://github.com/pmbstyle/L2Solo/releases/download/server-v0.1.2/L2Solo-Launcher-0.2.3-linux-x86_64.AppImage) |
<!-- STABLE_DOWNLOADS_END -->

On Windows, if you see the standard warning that the app publisher is unknown, click 'More info' and 'Run anyway'.

On Mac, after installing, run `xattr -dr com.apple.quarantine "/Applications/L2Solo Launcher.app"`


### From source (remote server setup)

```bash
git clone https://github.com/pmbstyle/L2Solo.git
cd L2Solo
npm install
npm start
```

This command starts the L2Solo Launcher. You can access it on the web at `<server-ip>:8090` 

Press `Start` in the launcher to run the server. 

Before opening the game server, L2Solo verifies `data/Geodata`, downloads and unpacks it if needed.

```bash
npm run geodata
npm run test:geodata
```
Manual download links:

https://l2solo.com/files/geodata-c4-client-20261027.zip

or

https://drive.google.com/file/d/1nIsV6wthb_hO6o1lPGGK8GVZf7GFlC0h/view?usp=sharing


**Configuration**

Committed defaults live in `config/default.ini`.

Private local overrides go to `config/local.ini`. This is where API keys and a machine-specific SQLite path belong.


## In-Game Commands

Enter dot commands in local chat. Replace `<name>` with a character's name; square brackets such as `[name]` mark an optional argument.

[Party and companions](#party-and-companions) · [Clan multi-party](#clan-multi-party) · [Save and restore parties](#save-and-restore-parties) · [Trade and services](#trade-and-services) · [Bot diagnostics](#bot-diagnostics) · [Menus and arena](#menus-and-arena)

### Party and companions

Your main party holds you and up to eight bots. Bots outside your clan can join under the normal invitation rules.

| Command | What it does |
| --- | --- |
| `.bot` / `.b` | Open companion controls, including loot pickup settings. |
| `.botparty` / `.bp` | Find bots to invite; distant companions catch up after joining. |
| `.invite <name>` / `/invite <name>` | Invite a bot into your main party. The native `/invite` action also works with a targeted bot. |
| `.joinparty [name]` | Ask to take over the named autonomous bot party, or the nearest eligible party if no name is given. Bots resume their autonomous party when you leave. |
| `.botfriends` / `.bf` | Open the friend list and const party management. |
| `.kick <name>` / `/dismiss <name>` | Dismiss one companion from the main party. |
| `.leave` / `/leave` | Dismiss your main companion party and all additional parties. |

Nearby bots also react to plain chat lines such as `hi`, `follow`, `wait`, `hunt`, `heal`, and `buff`.

### Clan multi-party

Clan leaders with an existing main party can assemble additional parties from their own clan's bots. Each additional party holds up to nine bots, including its leader. There is no separate limit on the number of additional parties.

| Command | What it does |
| --- | --- |
| `.createparty <leader>` | Create the next additional party with the named clan bot as its leader. |
| `.invite-p1 <name>` | Invite a clan bot into p1. |
| `.kick-p1 <name>` | Dismiss one member of p1. |
| `.leader-p1 <name>` | Promote an existing member to leader of p1. |
| `.dismiss-p1` | Dismiss all members of p1. |
| `.parties` | List additional parties, their leaders, members and movement orders. |
| `.p1 hold` | Hold current positions and defend nearby. |
| `.p1 follow` | Resume following the player. |
| `.p1 regroup` | Gather in formation, then resume the previous movement order. |
| `.main hold` / `.main follow` / `.main regroup` | Give a movement order to the main party. |
| `.all hold` / `.all follow` / `.all regroup` | Give a movement order to the main party and every additional party. |

Replace `p1` with `p2`, `p3`, and so on to address another party. Dismissing p1 does not renumber the others. Remove a bot from the main party before inviting it into an additional party.

Parties share combat targets and threats, while buffs, healing and resurrection stay inside each party. The main party's loot pickup toggle and client loot distribution apply to all additional parties. Leaving the main party or disconnecting dismisses the additional parties too.

### Save and restore parties

For clan leaders: keep one saved composition per character, including the main party, every additional party and their designated leaders. The save survives logout and server restarts.

| Command | What it does |
| --- | --- |
| `.partysave` | Save the current composition, replacing the previous save. |
| `.partyrestore` | Assemble the saved main party first, then all saved additional parties. Works when you are alone too. |

Already assembled members are skipped. Unavailable characters are reported in chat; repeat `.partyrestore` to retry them. If current parties conflict with the saved assignments, adjust those parties first.

### Trade and services

| Command | What it does |
| --- | --- |
| `.trade` / `/trade` | Open the trade window with the targeted bot; also works as a fallback to the native client trade action. |
| `.sell` | Sell all unequipped non-Adena items for 50% item value. |
| `.afksell` | Open the native private-sale window and leave a persistent AFK shop at the current peace-zone location. |
| `.afkbuy` | Open the native private-purchase window and reserve its Adena budget in a persistent AFK shop. |
| `.afkstop` | Close the active AFK shop remotely and return remaining reserved items or Adena. |
| `.buff` | Ask the targeted bot for a paid buff service. |

### Bot diagnostics

| Command | What it does |
| --- | --- |
| `.botstatus [name]` / `.bs [name]` | Show the bot overview panel, or detailed status for the named bot. |
| `.botpath [name]` / `.bpath [name]` | Inspect bot movement, town-route waypoints and geodata path diagnostics. |

### Menus and arena

| Command | What it does |
| --- | --- |
| `.menu` | Open the main in-game menu. |
| `.admin` | Open the admin menu. |
| `.go` | Start arena PvP. |

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.

Crafting with ❤️ by players for players 🤘

<img width="600"  alt="L2solo hit the star" src="https://github.com/user-attachments/assets/5e22564f-fe8e-4956-af21-1158f1849a31" />
