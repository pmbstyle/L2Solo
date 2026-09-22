// Generated population names use readable nicknames. The account id
// remains the durable technical identity; display names should look like
// authentic player nicknames across classic eras.
// 2000-2015 Lineage 2 Era Authentic Community Name Generator
// Massive multilingual pools (EN, TR, DE, BR, GR, RU translit),
// ultra-low framing (~2.5%), subtle leet (6%), vintage casing,
// meme/troll pools, zero trailing vendor numbers, strict 4-16 ASCII chars.

const POOLS = {
    // 1. Giran shop stalls only (serviceCrafter / crafter)
    vendor: [
        'Mats4Sale', 'ShopBot', 'LowPrice', 'Banker', 'AdenaGod', 'CheapMats',
        'AdenaPls', 'SellMats', 'BuyMats', 'BestPrice', 'ForgeMaster', 'SpoilSell',
        'AdenaFarmer', 'DwarfShop', 'TopCraft', 'CheapCraft', 'Store', 'MarketKing',
        'Bargain', 'QuickSell', 'Wholesale', 'FreeCraft', 'AdenaStore', 'BulkBuyer',
        'DiscountMats', 'CraftService', 'AnvilShop', 'MatsDealer', 'EmpireTrade',
        'CashFlow', 'GiranBank', 'GiranExpress', 'OreDealer', 'LeatherShop',
        'EnchantShop', 'ShotDepot', 'SoulShop', 'SpiritDepot', 'RecipeDealer',
        'KeyMats', 'PartSeller', 'DwarfWarehouse', 'AdenaFactory', 'ResourceKing',
        'PawnShop', 'GiranBroker', 'TradePost', 'CornerShop', 'CraftMart', 'ItemBazaar',
        'VendorBoy', 'CheapDyes', 'GemStore', 'ScrollDepot', 'AdenaSupply', 'ForgeHouse',

        'MatsTrader', 'AdenaKing', 'CraftKing', 'DwarfTrader', 'GiranTrader', 'CheapShots',
        'SoulshotShop', 'SpiritshotShop', 'CrystalDealer', 'OreShop', 'IronDealer', 'CoalDealer',
        'StemDealer', 'VarnishShop', 'SuedeDealer', 'ThreadShop', 'StoneDealer', 'BoneDealer',
        'CharcoalShop', 'AnimalSkin', 'BraidedHemp', 'SteelMaker', 'MithrilDealer', 'AdamantiteShop',
        'SilverDealer', 'GemDealer', 'CrystalShop', 'MaterialGuy', 'MatsMarket', 'MatsDepot',
        'MatsWarehouse', 'MatsFactory', 'MatsKing', 'MatsEmpire', 'MatsExpress', 'MatsHouse',
        'CraftDealer', 'CraftTrader', 'CraftFactory', 'CraftDepot', 'CraftKingdom', 'CraftDwarf',
        'DwarfCraft', 'DwarfForge', 'DwarfMarket', 'DwarfDealer', 'DwarfMats', 'DwarfBank',
        'DwarfMerchant', 'DwarfMart', 'DwarfTrade', 'DwarfFactory', 'DwarfMaster', 'DwarfSmith',
        'GiranShop', 'GiranMarket', 'GiranMart', 'GiranMerchant', 'GiranDealer', 'GiranCraft',

        'GiranMats', 'GiranForge', 'GiranStore', 'GiranTrade', 'GiranVendor', 'GiranDepot',
        'AdenaDealer', 'AdenaTrader', 'AdenaMarket', 'AdenaMart', 'AdenaMerchant', 'AdenaBanker',
        'AdenaDepot', 'AdenaWarehouse', 'AdenaExpress', 'AdenaTraderX', 'AdenaMaker', 'AdenaLord',
        'RichDwarf', 'PoorDwarf', 'TradeMaster', 'TradeKing', 'TradeLord', 'TradeDealer',
        'TradeVendor', 'TradeHouse', 'TradeDepot', 'TradeMarket', 'TradeMart', 'TradeCenter',
        'BestMats', 'GoodMats', 'FastMats', 'FreshMats', 'RareMats', 'PrimeMats',
        'TopMats', 'ProMats', 'MegaMats', 'SuperMats', 'UltraMats', 'RealMats',
        'CheapOre', 'CheapSteel', 'CheapSoulshots', 'CheapScrolls', 'CheapCrystals', 'CheapRecipes',
        'CheapParts', 'CheapGems', 'CheapLeather', 'CheapSuede', 'CheapVarnish', 'CheapStem',
        'BuyEverything', 'SellEverything', 'BuyAllMats', 'SellAllMats', 'NeedMats', 'NeedAdena',
        'NeedCrystals', 'NeedOre', 'NeedRecipes', 'NeedParts', 'NeedShots', 'NeedScrolls',

        'RecipeShop', 'RecipeMarket', 'RecipeMart', 'RecipeMaster', 'RecipeKing', 'RecipeTrader',
        'RecipeStore', 'RecipeHouse', 'RecipeDepot', 'RecipeVendor', 'RecipeBroker', 'RecipeDwarf',
        'SoulshotDealer', 'SoulshotDepot', 'SoulshotMart', 'SoulshotKing', 'SoulshotTrader', 'SoulshotGuy',
        'SpiritshotDealer', 'SpiritshotMart', 'SpiritshotKing', 'SpiritshotTrader', 'SpiritshotGuy', 'SpiritshotDepot',
        'ScrollDealer', 'ScrollShop', 'ScrollMarket', 'ScrollMart', 'ScrollTrader', 'ScrollKing',
        'EnchantDealer', 'EnchantMarket', 'EnchantMart', 'EnchantTrader', 'EnchantKing', 'EnchantMaster',
        'CrystalKing', 'CrystalTrader', 'CrystalMarket', 'CrystalMart', 'CrystalDepot', 'CrystalMaster',
        'GemKing', 'GemTrader', 'GemMarket', 'GemMart', 'GemDealerX', 'GemMaster',
        'ForgeKing', 'ForgeLord', 'ForgeDealer', 'ForgeTrader', 'ForgeMarket', 'ForgeDepot',
        'SmithMaster', 'SmithShop', 'SmithDealer', 'SmithTrader', 'SmithForge', 'SmithMarket',
        'SpoilTrader', 'SpoilMarket', 'SpoilDealer', 'SpoilKing', 'SpoilMats', 'SpoilShop',
        'MarketMaster', 'MarketLord', 'MarketDealer', 'MarketTrader', 'MarketDwarf', 'MarketBoss',
        'MerchantKing', 'MerchantLord', 'MerchantDwarf', 'MerchantGuy', 'MerchantPro', 'MerchantX'
    ],

    // 2. Open-world hunting dwarves
    dwarf: [
        'SpoilMe', 'Sweeper', 'MiniTank', 'FatBoy', 'Shorty', 'Stout', 'Anvil',
        'SpoilKing', 'Swept', 'GoldDigger', 'Pickaxe', 'LilHammer', 'MiniMe',
        'HeavyLoad', 'Crusher', 'OreMiner', 'SmallBeast', 'StoneBreaker', 'BeardPower',
        'PocketTank', 'Chubby', 'Greedy', 'Nugget', 'MineCart', 'IronBeard', 'Rubble',
        'DeepDelver', 'Gimlet', 'Clansmith', 'Stumpy', 'DwarvenRage', 'SmashHead',
        'Piledriver', 'Bedrock', 'GoldRush', 'Payday', 'Quarry', 'Boulderdash',
        'Spanned', 'MithrilGrip', 'ForgeSpike', 'KegBeard', 'RockChewer', 'HeavyGut',
        'PocketSize', 'ShortFuse', 'Granite', 'Basalt', 'CoalFace', 'IronGut',
        'Sledge', 'Bulldozer', 'MiniBeast', 'ToughDwarf', 'Sparks', 'DeepMiner',
        // Multilingual additions
        'Cucel', 'Madenci', 'KocaSakal', 'Demirci', 'Altinci', 'Kazmaci',
        'Tontis', 'TasKafa', 'KisaBacak', 'Cevherci', 'Gobekli', 'UstaCekic',
        'Zwergi', 'Eisenbart', 'Kleiner', 'Bergmann', 'Schmiedl', 'Erzjager',
        'Goldbart', 'Steinkopf', 'Hammerchen', 'KohleMann', 'Dickbauch',
        'Kupferbart', 'AnaoBrabo', 'Baixinho', 'Barbudo', 'Mineirinho',
        'Ferreiro', 'Pedreira', 'OuroLouco', 'Martelinho', 'Gordinho',
        'CavaTudo', 'PedraDura', 'Rachador', 'KontoPodaros', 'Sideras',
        'Nanos', 'Skliros', 'Petrokefali', 'Moustakas', 'Tsakmakis',
        'Karbounas', 'Skaptis', 'Vrachos', 'Mikroulis', 'Chontros',
        'Borodach', 'Kuznets', 'Rudokop', 'Tolstyi', 'Korotysh',
        'Kamnegryz', 'Zolotnik', 'Shahter', 'Molotok'
    ],

    // 3. Dagger (TH, PW, AW)
    dagger: [
        'BehindYou', 'Backstab', 'CritHax', 'Sneaky', 'LethalBlow', 'Deadly',
        'Shank', 'Trickster', 'BlindSpot', 'GhostWalk', 'Stabber', 'Bleed',
        'Stealth', 'QuickStab', 'Shade', 'FastKnife', 'ShadowStep', 'BackStabber',
        'SilentStab', 'ThroatCut', 'Heartseeker', 'DaggerPro', 'Shiv', 'ShadowBlade',
        'Ambush', 'GutStab', 'Surprise', 'VenomBlade', 'GhostDagger', 'Switchblade',
        'Pinch', 'Blink', 'ShadowDash', 'FatalStrike', 'Nightfall', 'Stiletto',
        'KidneyShot', 'Cloak', 'Vanish', 'Assassinate', 'PoisonEdge', 'ShankYou',
        'ColdSteel', 'RazorEdge', 'SilentKill', 'ShadowStab', 'FadeOut', 'Blindside',
        'Cutthroat', 'Slice', 'Dice', 'Ghostly', 'Razor', 'Viper', 'Venom', 'Toxin',
        'Scar', 'Dexter', 'Sylar', 'Riddick', 'Specter', 'Phantom', 'Wraith',
        // Multilingual additions
        'Arkadan', 'Bicakci', 'SessizOlum', 'Golge', 'Keskin', 'Pusu',
        'HainBicak', 'Karanlik', 'Sirtindan', 'KanliBicak', 'GizliVurus',
        'TekBicak', 'Katil', 'Zehirli', 'GeceAvci',
        'Meuchler', 'Dolch', 'Hinterhalt', 'SchattenTod', 'Messerheld',
        'LeiseKlinge', 'NachtStich', 'BlutDolch', 'GiftKlinge', 'Ruckstich',
        'Assassino', 'Facada', 'Sorrateiro', 'Punhal', 'NaSombra',
        'CortaGarganta', 'Emboscada', 'Veneno', 'MataQuieto', 'Costas',
        'Laminal', 'FacaCega', 'Sangrento',
        'Mahairas', 'Skia', 'Dolofonos', 'PisoPlati', 'Kryfos',
        'Nychtovatis', 'Fidi', 'Dilitirio', 'MavriLepi', 'Kopis',
        'Tihiy', 'Kinzhal', 'Ubiytsa', 'Ten', 'Nochnik',
        'Krovnik', 'Yadovityi', 'Zasada', 'Rezhik', 'ZaSpinoy',
        'Nevidimka', 'Klinok', 'Temniy', 'Reznya'
    ],

    // 4. Archer (Hawkeye, SR, PR)
    archer: [
        'Sniper', 'DoubleShot', 'OneArrow', 'KiteGod', 'LongShot', 'ArrowRain',
        'EagleEye', 'DeadEye', 'OutOfRange', 'BowMaster', 'Bullseye', 'Snipe',
        'FastBow', 'Hawkeye', 'ArrowBoy', 'Kiter', 'OneShot', 'FarShot',
        'Piercing', 'Headshot', 'StunShot', 'WindRunner', 'Bowstring', 'Sharpshooter',
        'RangeGod', 'SkyHunter', 'ArrowDrop', 'FarReach', 'QuickShot', 'Fletching',
        'Crossbow', 'Quiver', 'Distance', 'LongRange', 'Pinpoint', 'Overwatch',
        'ApexShot', 'GhostArrow', 'TrueAim', 'Marksman', 'TargetAcquired', 'FlightTime',
        'Rainmaker', 'ArrowFall', 'DeadlyAim', 'ClearShot', 'BowPro', 'Recurve',
        'ArrowStorm', 'FastArrow', 'Windshot', 'TrueShot', 'Maverick', 'Cobra',
        // Multilingual additions
        'Okcu', 'TekOk', 'KartalGoz', 'Uzakci', 'Yayci', 'TamIsabet',
        'KaraOk', 'RuzgarOku', 'AvciOk', 'DeliciOk', 'UzakVurus',
        'Bogner', 'Pfeilhagel', 'Adlerauge', 'Fernschuss', 'Treffer',
        'Waldjager', 'ScharfPfeil', 'BogenHeld', 'Weitschuss', 'WindPfeil',
        'Arqueiro', 'FlechaCerta', 'OlhoDeAguia', 'TiroLonge', 'Flechada',
        'Cacador', 'MiraBoa', 'ChuvaFlecha', 'ArcoForte', 'TiroSeco',
        'Toxotis', 'Velos', 'Aetomati', 'Makrinos', 'Kynigos',
        'AnemosVelos', 'StoKentro', 'Toxaras', 'GrigoroVelos', 'MatiAetou',
        'Luchnik', 'Strela', 'Metkiy', 'Dalniy', 'Sokol',
        'Ohhotnik', 'VeterStrel', 'Tochniy', 'LukMaster', 'BystrayaStrela',
        'BezPromaha', 'OrlinyiGlaz', 'Dalnoboy'
    ],

    // 5. Mage / Nuker (SPS, SH, Sorcerer, Necromancer)
    mage: [
        'HydroBlast', 'Prominence', 'DarkVortex', 'CorpseBurst', 'GlassCannon',
        'Overhit', 'Nuke', 'Zap', 'Boom', 'SpellBlast', 'SlowCast', 'Fireball',
        'FrostBolt', 'BoneSpear', 'DeathSpike', 'WildMagic', 'Nuker', 'ManaBurn',
        'Ignis', 'ArcanePower', 'Spellbinder', 'Surrender', 'CurseGloomy', 'Blizzard',
        'SolarFlare', 'Erase', 'CurseDeath', 'ChaosMage', 'DarkCast', 'SoulVortex',
        'VampiricClaw', 'InfernoMage', 'IceStorm', 'SleepPls', 'Silence', 'CorpseLife',
        'BSpark', 'FrostGod', 'Pyro', 'AquaBlast', 'Flare', 'SpellCrusher',
        'ArcaneLord', 'DarkBuster', 'FlameStrike', 'Freeze', 'DeepFreeze', 'ShadowFlare',
        'Doom', 'Inferno', 'Abyss', 'Void', 'Ruin', 'Decay', 'Blight', 'Ashen', 'Rift',
        // Multilingual additions
        'Buyucu', 'KaraBuyu', 'Atesci', 'Buzcu', 'RuhEmici', 'Lanetci',
        'Alev', 'KaraRuh', 'Yildirimci', 'Donmus', 'OlumBuyusu',
        'Hexer', 'FeuerMagier', 'EisHexe', 'DunkelZauber', 'SeelenRaub',
        'FlammenKind', 'FrostHexer', 'TodesMagie', 'BlitzMage', 'NachtHexe',
        'MagoLoko', 'Feiticeiro', 'FogoBrabo', 'GeloPuro', 'AlmaNegra',
        'Bruxao', 'ChamaViva', 'MorteMagica', 'Trovao', 'Congelado',
        'Magos', 'Fotia', 'Pagomenos', 'MavriMageia', 'Psihofagos',
        'Kataramenos', 'Astrapi', 'Flogas', 'Skotinos', 'Nekromantis',
        'Koldun', 'Moroz', 'Ognennyi', 'CherniyMag', 'Dushegrab',
        'Proklyatyi', 'Molniya', 'Ledyanoy', 'TemnyiMag', 'Nekromant',
        'Ogon', 'Mraz', 'Zaklinatel', 'SmertMag', 'NochKoldun',
        'Pogibely'
    ],

    // 6. Tank (Paladin, DA, TK, SK)
    tank: [
        'MeatShield', 'HateMe', 'StunLock', 'IronWall', 'CantDie', 'AggroPls',
        'Bunker', 'ShieldStun', 'Fortress', 'Vengeance', 'Stunner', 'TinCan',
        'HoldAggro', 'Bodyguard', 'MainTank', 'Aegis', 'NoDamage', 'DefendMe',
        'ShieldBash', 'UltimateDef', 'TouchOfLife', 'DarkPanther', 'Tribunal', 'Judgment',
        'PaliGod', 'Avenger', 'HolyArmor', 'ShieldWall', 'Unstoppable', 'Bastion',
        'BrickWall', 'IronHide', 'Reflect', 'HeavyPlate', 'ShieldBlock', 'Provoke',
        'TauntMe', 'Gargoyle', 'Bulwark', 'Sentinel', 'PaladinPro', 'DarkKnight',
        'SteelWall', 'Absorb', 'Ironclad', 'TitanWall', 'Vanguard', 'Arbiter',
        'Tremor', 'Sunder',
        // Multilingual additions
        'Kalkan', 'TasDuvar', 'Olmez', 'Dayanikli', 'KocaZirh',
        'DemirKale', 'OnSaf', 'Sarsilmaz', 'Zirhli', 'KalkanUsta',
        'SchildMann', 'Eisenwand', 'Unsterblich', 'PanzerBert', 'Festung',
        'StahlHaut', 'Blocker', 'Mauer', 'RitterTank', 'DickPlatte',
        'TanqueBrabo', 'Muralha', 'Escudao', 'NaoMorro', 'FerroPuro',
        'SeguraTudo', 'PedraViva', 'Blindado', 'Parede', 'Cavaleiro',
        'Aspida', 'Teihos', 'Atromitos', 'Siderenios', 'Frourios',
        'VrachosTank', 'Athanatos', 'Fylakas', 'Palikari', 'Thoras',
        'Shit', 'Stena', 'Bronya', 'Krepost', 'Zheleznyi',
        'Neubivaem', 'Zashitnik', 'Tverdiy', 'Latnik', 'Bogatyr'
    ],

    // 7. Buffer / Healer (Bishop, EE, SE, Prophet, WC, OL)
    buffer: [
        'BuffSlave', 'NeedMana', 'HealBot', 'FreeBuff', 'ManaBattery', 'Medkit',
        'ResPls', 'CleanseMe', 'NoblessePls', 'HolyLight', 'FullBuff', 'BuffBot',
        'HealOrDie', 'Recharge', 'Lifeline', 'Blessing', 'ManaPls', 'MajorHeal',
        'GreaterHeal', 'ChainHealer', 'PartyHeal', 'Trance', 'DryadRoot', 'WindWalkBot',
        'HasteBot', 'BatteryPack', 'EmergencyRes', 'Salvation', 'Purify', 'LifeFeast',
        'SealOfSilence', 'SoulCry', 'ChantLord', 'GodSupport', 'PocketHeal', 'Nurse',
        'FirstAid', 'ManaFeeder', 'HealMachine', 'SafeGuard', 'Seraphic', 'DivineHeal',
        'AuraHeal', 'ManaRestore', 'Sanctuary', 'Vitalizer', 'SupportGod', 'ProphetBoy',
        // Multilingual additions
        'Sifaci', 'CanBas', 'ManaVer', 'Diriltici', 'Kutsayan', 'Destekci',
        'CanDoldur', 'DuaEt', 'HizVer',
        'Heiler', 'Segner', 'ManaSpender', 'LebensRetter', 'BuffMich',
        'Priester', 'HeilDich', 'SegenMann', 'ManaQuelle',
        'Curandeiro', 'BenzeTudo', 'ManaAi', 'Ressuscita', 'Padrezinho',
        'CuraNoob', 'VidaCheia', 'Benzao', 'DaBuff',
        'Giatraki', 'Evlogia', 'ManaDose', 'Anastasi', 'Therapeia',
        'PapasBuff', 'ZoiMou', 'Voitheia', 'Agios',
        'Lekar', 'Baffer', 'ManaDavai', 'Voskresi', 'Celitel',
        'Blagoslov', 'Zhizn', 'Podderzhka', 'Svyatoy', 'HilniMenya',
        'ManaBrat', 'Spasatel', 'Vrach'
    ],

    // 8. Melee DPS (Gladiator, Destroyer, Tyrant, Warlord)
    melee: [
        'FrenzyBoy', 'RedHP', 'SonicBlaster', 'TripleSlash', 'Whirlwind',
        'PoleFarm', 'Crush', 'DualWield', 'RageMode', 'Zealot', 'Bison',
        'FistOfFury', 'GladGod', 'DestroKing', 'HulkSmash', 'OverPower',
        'Berserk', 'LionHeart', 'FatalStrike', 'HammerCrush', 'ThunderStorm', 'Earthquake',
        'SonicBuster', 'Hurricane', 'TotemWolf', 'TotemOgre', 'GutsBoy', 'FrenzyGod',
        'Buster', 'SoulBreaker', 'IronPunch', 'HeavyBlade', 'SpinToWin', 'PoleKing',
        'BattleRoar', 'RageQuit', 'TitanGod', 'DualMaster', 'FuryStrike', 'FistMaster',
        'Feral', 'Savage', 'Brutal', 'Rancor', 'Stryker', 'Guts',
        // Multilingual additions
        'Yumrukcu', 'Baltaci', 'Savasci', 'KafaKiran', 'Delikanli',
        'VurKac', 'KilicUsta', 'DeliOglan', 'Ezici',
        'Schlager', 'AxtMann', 'Prugler', 'KlingenHans', 'WutKerl',
        'Haudrauf', 'KampfSau', 'Brecher', 'FaustHeld',
        'Porreiro', 'Machadao', 'QuebraTudo', 'Brigador', 'Porrada',
        'Esmaga', 'MaoPesada', 'Furioso', 'CortaTudo',
        'Maxitis', 'Tsekouri', 'Spastis', 'Varis', 'Trelos',
        'Gkremistis', 'Gronthia', 'Sfagi', 'Polemisti',
        'Rubaka', 'Topor', 'Drakun', 'BerserkRus', 'Kulak',
        'Lomatel', 'Buynyi', 'Sechka', 'Mordoboy', 'Tyazhelyi'
    ],

    // 9. BD / SWS
    dancer: [
        'DanceSlave', 'SongSlave', 'FuryDance', 'EarthSong', 'FireDance',
        'HunterSong', 'WaterSong', 'PartyBuff', 'SwSBot', 'BDBot', 'DualDancer',
        'VampDance', 'WarriorDance', 'Inspiration', 'WindSong', 'Meditation',
        'VitalitySong', 'MysticDance', 'ShadowDance', 'BladeSinger', 'SwordDancer',
        'BuffBotBD', 'BuffBotSwS', 'DuoBuffer', 'SingForYou', 'DanceForYou',
        'Tempo', 'Rhythm', 'SongMaster', 'DanceMaster', 'TwoSwords', 'BladeWaltz',
        'SirensDance', 'SongOfLife', 'DualSinger', 'SirenSong', 'DanceFlow',
        // Multilingual additions
        'Dansci', 'Sarkici', 'KilicDans', 'GeceDans', 'Sazci', 'Oynak',
        'Ritimci',
        'Tanzer', 'Sanger', 'KlingenTanz', 'NachtLied', 'TanzBert',
        'LiedMann', 'Rhythmus',
        'Dancarino', 'Cantador', 'DancaAi', 'CantaMais', 'RitmoLoko',
        'DuasLaminas', 'Serenata',
        'Horeftis', 'Tragoudi', 'Xoros', 'DyoSpathia', 'Rythmos',
        'NyhtaXoros', 'Melodia',
        'Tantsor', 'Pevets', 'Pesnya', 'DvaMecha', 'Ritm',
        'Plyashi', 'NochnoyTants', 'Bayan'
    ],

    // 10. PvP / PK & Competitive Jargon
    pvp: [
        'SitDown', 'DropAdena', 'Pwnage', 'Ownage', 'DontCry', 'NoMercy', 'DiePls',
        'Back2Town', 'CleanKill', 'Vendetta', 'GetRekt', 'Owned', 'Lag', 'Disconnect',
        'Ransom', 'Ruthless', 'OneHit', 'DeathKiller', 'Reaper', 'Nemesis', 'Pain',
        'Headshot', 'Lethal', 'Outplay', 'RageQuit', 'SilentKill', 'Overkill',
        'TargetFound', 'GgNoob', 'NoobSlayer', 'CryMore', 'EzPz', 'GgEasy', 'FeedMe',
        'TrashTalk', 'PkCounter', 'RedKarma', 'TownScroll', 'FloorLover', 'GraveDigger',
        'Punisher', 'Executioner', 'Carnage', 'FatalError', 'Dominance', 'Bloodlust',
        'Ares', 'Vandal', 'Rapture', 'Revolt', 'Riot', 'Havoc', 'Chaos', 'Panic',
        'Rage', 'Wrath', 'Grudge', 'Hatred', 'Karma', 'Vengeance', 'Requiem',
        'Oblivion', 'Eclipse', 'Paradox', 'Axiom', 'Memento', 'Nocturne',
        // Multilingual additions
        'YatAsagi', 'KoyuneDon', 'KesSesini', 'TekYedin', 'Kacma',
        'YereSerdim', 'Agla', 'Kirmizi', 'KelleAvci', 'EzdimSeni',
        'KasabayaDon', 'KanDavasi', 'OlArtik',
        'LegDichHin', 'HeulDoch', 'TotMann', 'KeineChance', 'ZurStadt',
        'BlutRache', 'KopfAb', 'RennWeg', 'DuNoob', 'SterbEndlich',
        'KeineGnade', 'RoterMann', 'TodSicher',
        'ChoraNao', 'MorreLogo', 'VoltaPraVila', 'DeitaAi', 'SemChance',
        'TeMatei', 'CorreNoob', 'Vermelhinho', 'TomaEssa', 'CaiMorto',
        'SemPiedade', 'VaiChorar', 'MataMata', 'Treta',
        'PeseKato', 'Klapse', 'FygeNoob', 'Pethanes', 'KokkinoPK',
        'StoXoma', 'Killx', 'SkotoseTon', 'PisoPoli', 'HorIsEleos',
        'PareTa', 'TrelosPK', 'Ekdikisi',
        'Lezhi', 'UmriUzhe', 'VGoRod', 'BezShansov', 'KrasniyPK',
        'PlachNoob', 'Poluchi', 'Mestnik', 'Ubivator', 'Begom',
        'NaPol', 'BezZhalosti', 'KrovZaKrov', 'SmertTebe',
        'SlilTebya', 'Ganknul', 'Nagibator'
    ],

    // 11. Short & Punchy OG Nicks (4-6 Characters) + Absurd Short Caps
    ogShort: [
        'Vex', 'Kael', 'Dusk', 'Void', 'Echo', 'Rune', 'Seth', 'Nyx', 'Grim', 'Rex',
        'Cole', 'Faye', 'Zack', 'Spike', 'Raven', 'Zero', 'Apex', 'Blaze', 'Storm',
        'Frost', 'Bane', 'Fatal', 'Toxic', 'Swift', 'Rogue', 'Titan', 'Fury', 'Brute',
        'Nova', 'Volt', 'Ash', 'Shade', 'Wraith', 'Cinder', 'Flux', 'Jinx', 'Lynx',
        'Onyx', 'Zeal', 'Hawk', 'Wolf', 'Fang', 'Rust', 'Slag', 'Pike', 'Gore',
        'Daze', 'Mist', 'Gloom', 'Axel', 'Kane', 'Blink', 'Claw', 'Crag', 'Crux',
        'Dart', 'Dirk', 'Drift', 'Flint', 'Gale', 'Haze', 'Helm', 'Hex', 'Iron',
        'Jolt', 'Keen', 'Loom', 'Lurk', 'Mace', 'Nox', 'Rift', 'Rook', 'Scab',
        'Scar', 'Scythe', 'Shank', 'Skulk', 'Sleet', 'Spur', 'Vail', 'Vane', 'Veil',
        'Vow', 'Warp', 'Wick', 'Wisp', 'Wrack', 'Nero', 'Snake', 'Sith', 'Jedi',
        'Thrall', 'Grom',
        'GOOO', 'BOOM', 'OMG', 'WTF', 'WUT', 'BRRR', 'ZERG', 'KEK', 'LUL', 'PFF', 'LOL',
        // Multilingual additions
        'Efe', 'Bora', 'Kaan', 'Mert', 'Alp', 'Ayaz', 'Sarp', 'Ozan',
        'Kurt', 'Bozkir', 'Alev', 'Yaman', 'Tufan', 'Yigit', 'Kuzgun',
        'Kilic', 'Pars', 'Eren', 'Baran', 'AresTR',
        'Klaus', 'Fritz', 'Wolfi', 'Hans', 'Ulf', 'Rolf', 'Jager',
        'Sturm', 'Blitz', 'Nebel', 'Rabe', 'Eis', 'Glut', 'Faust',
        'Krieg', 'Zorn', 'Dolch', 'Falke', 'Wulf', 'Klinge',
        'Zeca', 'Beto', 'Nando', 'Tiao', 'Dudu', 'Guto', 'Japa',
        'Brabo', 'Loko', 'Fera', 'Raiva', 'Fogo', 'Gelo', 'Lobo',
        'Corvo', 'Touro', 'Onca', 'Trovao', 'Sombra', 'Maluco',
        'Nikos', 'Giorgos', 'Tasos', 'Kostas', 'Sakis', 'Makis', 'Akis',
        'Fotis', 'Skia', 'Fidi', 'Lykos', 'Aetos', 'Floga', 'Pagos',
        'Nyxta', 'Thira', 'Vraxos', 'Mavro', 'Trelos', 'Krios',
        'Vlad', 'Sasha', 'Misha', 'Dima', 'Yura', 'Kolya', 'Slava',
        'Volk', 'Voron', 'Grom', 'Moroz', 'Ogon', 'Ten', 'Bes',
        'Zver', 'Klyk', 'Buran', 'Voin', 'Rusak', 'Koshei', 'Vihor',
        'Kaban', 'Sokol', 'Bars', 'Grad'
    ],

    // 12. Era Memes, Troll Names & Internet Culture
    memes: [
        'Error404', 'NotAnNPC', 'AltF4', 'WoWSux', 'NEO', 'AFK', 'BRB', 'ReLoaD',
        'NoobKiller', 'Pwned', 'Owned', 'UGotPwned', 'CtrlAltDel', 'FakeNPC',
        'NotABot', 'LeeroyJenkins', 'ChuckNorris', 'Norris', 'Roflcopter',
        'Lollerskates', 'Haxxor', 'H4x0r', 'Imba', 'EpicFail', 'Failboat',
        'UMad', 'QQmore', 'QQ', 'PewPew', 'PewPewPew', 'BoomHeadshot', 'OneShot',
        'CritHappens', 'CritMachine', 'CritOrDie', 'MissMe', 'DodgeThis', 'NerfMe',
        'NerfThis', 'DeleteSystem32', 'BuffMe', 'ImbaNoob',
        // Multilingual additions
        'AnanZaa', 'LagVar', 'KoptuLan', 'CafeNet', 'PcDondu', 'NoobLa',
        'AgaBuff', 'KankaRes', 'CikGir', 'AltF4TR',
        'KartoffelPC', 'LaggMeister', 'KeksDose', 'HauAbNoob', 'MuttiRuft',
        'KeinMana', 'BuffBitte', 'KellerKind',
        'HueHueBR', 'MorreNoob', 'Kkkkkkk', 'NetCaiu', 'MaeChamou',
        'SemMana', 'BuffAe', 'LanHouse',
        'ElaRe', 'TiLesRe', 'PameNoob', 'ManaTelos', 'Kafeneio',
        'MalakaLag', 'DoseBuff',
        'PrivetNoob', 'MamaZovet', 'InetUpal', 'DavaiBuff', 'NetMana',
        'Ololo', 'PatsanRes', 'YaAFK', 'NuPogodi', 'jajajaja', 'axaxax'
    ],

    // 13. Pop Culture & Rock/Metal Bands (Anime, Games, Lore)
    popCulture: [
        'LinkinPark', 'Metallica', 'Nightwish', 'Nirvana', 'Manson', 'Ozzy', 'Cobain',
        'Hellsing', 'Alucard', 'Griffith', 'Itachi', 'Sasuke', 'Akatsuki', 'Kira',
        'Shinigami', 'Bankai', 'Zangetsu', 'Aizen', 'Byakuya', 'Gaara', 'Kakashi',
        'Jiraiya', 'Orochimaru', 'Sephiroth', 'Vincent', 'Cloud', 'Squall', 'Dante',
        'Vergil', 'Raiden', 'Solidus', 'Revan', 'Illidan', 'Arthas', 'Kaelthas',
        'Malfurion', 'Kelthuzad', 'Diablo', 'Sawyer', 'Lestat', 'Spawn', 'Kenshin', 'Inuyasha',
        // Multilingual additions
        'PolatAlemdar', 'Memati', 'Abdulhey', 'KaraMurat', 'TarkanTR',
        'CuneytArkin', 'DeliYurek', 'Karahanli', 'Kurtlar',
        'Rammstein', 'TillLinde', 'Siegfried', 'Hagen', 'Wotan',
        'Nibelung', 'FaustDE', 'Krabat',
        'CapitaoNasc', 'TropaElite', 'Cangaceiro', 'Lampiao', 'Curupira',
        'Saci', 'Boitata', 'Sepultura', 'AngraBR',
        'Leonidas', 'Spartakos', 'Achilleas', 'Odysseas', 'Herkules',
        'HadesGR', 'ZeusGR', 'AresGR',
        'Bogatyr', 'Dobrynya', 'IlyaMurom', 'Koschei', 'BabaYaga',
        'Perun', 'Veles', 'Ruslan', 'Sadko'
    ]
};

function seededCategory(seed, values) {
    return values[(seed >>> 3) % values.length];
}

function resolveCategory(base, seed = 0) {
    if (!base) return null;
    const classId = Number(base.classId);
    const role = String(base.role || '').toLowerCase();
    const isDwarf = base.race === 4 || [53, 54, 55, 56, 57, 117, 118].includes(classId);
    const isVendor = Boolean(base.serviceCrafter || role === 'crafter' || role === 'vendor');

    if (isVendor && isDwarf) return 'vendor';
    if (isDwarf) return 'dwarf';

    if ([7, 22, 35].includes(classId)) return seededCategory(seed, ['dagger', 'archer']);
    if ([8, 23, 36, 93, 101, 108].includes(classId)) return 'dagger';
    if ([9, 24, 37, 92, 102, 109].includes(classId)) return 'archer';
    if ([10, 25, 38].includes(classId)) return seededCategory(seed, ['mage', 'buffer']);
    if ([11, 12, 13, 14, 26, 27, 28, 39, 40, 41, 94, 95, 96, 103, 104, 110, 111].includes(classId)) return 'mage';
    if ([4, 5, 6, 19, 20, 32, 33, 90, 91, 99, 106].includes(classId)) return 'tank';
    if ([15, 16, 17, 29, 30, 42, 43, 49, 50, 51, 52, 97, 98, 105, 112, 115, 116].includes(classId) || role === 'buffer') return 'buffer';
    if ([21, 34, 100, 107].includes(classId)) return 'dancer';

    if (classId === 0) return seededCategory(seed, ['dagger', 'archer', 'tank', 'melee']);
    if (classId === 18 || classId === 31) return seededCategory(seed, ['dagger', 'archer', 'tank', 'dancer', 'melee']);
    if ([1, 2, 3, 44, 45, 46, 47, 48, 88, 89].includes(classId)) return 'melee';
    if (role === 'dps') return seededCategory(seed, ['dagger', 'archer', 'tank', 'dancer', 'melee']);

    return null;
}

function hash(val) {
    let h = (Number(val) || 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0);
}

// Subtle leet-speak (halved to 6% chance, substitutes 1, 2, or 3 letters)
function applyLeet(text, seed) {
    if ((seed % 100) >= 6) return text;
    if (/\d/.test(text)) return text;

    const chars = text.split('');
    const leetMap = { e: '3', E: '3', i: '1', I: '1', o: '0', O: '0', a: '4', A: '4' };
    const eligible = [];

    chars.forEach((c, idx) => {
        if (leetMap[c]) eligible.push(idx);
    });

    if (eligible.length === 0) return text;

    const countRoll = (seed >>> 6) % 100;
    let targetCount = 1;
    if (countRoll < 25 && eligible.length >= 2) targetCount = 2;
    if (countRoll < 5 && eligible.length >= 3) targetCount = 3;

    const chosenIndices = [];
    const pool = [...eligible];
    for (let i = 0; i < targetCount && pool.length > 0; i++) {
        const pickIdx = (seed >>> (8 + i * 5)) % pool.length;
        chosenIndices.push(pool[pickIdx]);
        pool.splice(pickIdx, 1);
    }

    chosenIndices.forEach((idx) => {
        chars[idx] = leetMap[chars[idx]];
    });

    return chars.join('');
}

function applyCasing(text, seed) {
    const styleRoll = (seed >>> 11) % 100;

    if (styleRoll < 12 && text.length <= 7) return text.toUpperCase();
    if (styleRoll >= 12 && styleRoll < 22) return text.toLowerCase();

    if (styleRoll >= 22 && styleRoll < 40) {
        const parts = text.split(/(?=[A-Z])/);
        if (parts.length >= 2) {
            return parts[0].toUpperCase() + parts.slice(1).join('').toLowerCase();
        }
        const cut = Math.min(3, Math.max(2, Math.floor(text.length / 2)));
        return text.slice(0, cut).toUpperCase() + text.slice(cut).toLowerCase();
    }

    if (styleRoll >= 40 && styleRoll < 55) {
        return text.split('').map((char, i) => {
            const bit = (seed >>> (i % 24)) & 1;
            return bit ? char.toUpperCase() : char.toLowerCase();
        }).join('');
    }

    return text;
}

// Framing reduced by 66% (~2.5% chance total)
function applyFraming(text, seed) {
    const frameRoll = (seed >>> 19) % 100;

    if (frameRoll === 0) {
        const framed = `xX${text}Xx`;
        return framed.length <= 16 ? framed : text;
    }
    if (frameRoll === 1) {
        const framed = `oO${text}Oo`;
        return framed.length <= 16 ? framed : text;
    }
    if (frameRoll === 2 && (seed & 1)) {
        const framed = text.length <= 8 ? `xXx_${text}_xXx` : `xXx${text}xXx`;
        return framed.length <= 16 ? framed : text;
    }

    return text;
}

function nameFor(index, base = null) {
    const seed = hash(index);
    const category = resolveCategory(base, seed);

    const roll = seed % 100;
    let pool;

    if (category === 'vendor') {
        pool = POOLS.vendor;
    } else if (category && roll < 45) {
        pool = POOLS[category];
    } else if (roll < 65) {
        pool = POOLS.ogShort;
    } else if (roll < 80) {
        pool = POOLS.pvp;
    } else if (roll < 90) {
        pool = POOLS.memes;
    } else {
        pool = POOLS.popCulture;
    }

    const baseName = pool[(seed >>> 8) % pool.length];

    let processed = applyLeet(baseName, seed);
    processed = applyCasing(processed, seed);
    processed = applyFraming(processed, seed);

    if (processed.length > 16) processed = processed.slice(0, 16);
    while (processed.length < 4) processed = `${processed}x`;

    return processed;
}

function poolKeyFor(index, base = null) {
    const seed = hash(index);
    const category = resolveCategory(base, seed);
    if (category === 'vendor') return 'vendor';
    const roll = seed % 100;
    if (category && roll < 45) return category;
    if (roll < 65) return 'ogShort';
    if (roll < 80) return 'pvp';
    if (roll < 90) return 'memes';
    return 'popCulture';
}

module.exports = { nameFor, poolKeyFor, resolveCategory };