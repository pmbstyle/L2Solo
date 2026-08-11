require('../src/Global');
const assertC4MonsterLocation = require('./helpers/assert_c4_monster_location');
const assertMonsterEmptyBeforeSlice = require('./helpers/assert_monster_empty_before_slice');
const mobIds=[812,813,815,816,817,818,819,820,821,822,823,824,825,826,827,828,829,830,831,977,980,983,1061,1062,1064,1065,1066,1067,1069,1070,1072,1075,1078,1081];
assertC4MonsterLocation({
    slug:'c4_tower_of_insolence',displayName:'Tower of Insolence',areaId:'c4-tower-of-insolence',mobIds,importedNpcIds:mobIds,bindingSlugs:['c4_tower_of_insolence'],
    spawnCounts:[[812,14],[813,14],[815,28],[816,16],[817,14],[818,19],[819,10],[820,16],[821,15],[822,14],[823,13],[824,17],[825,16],[826,11],[827,13],[828,8],[829,9],[830,20],[831,10],[977,2],[980,2],[983,3],[1061,17],[1062,10],[1064,7],[1065,10],[1066,22],[1067,19],[1069,22],[1070,10],[1072,13],[1075,5],[1078,3],[1081,2]],
    respawn:230,respawnByMob:{812:165,813:165,815:165,816:180,817:180,818:165,819:165,820:180,821:165,822:180,823:210,824:190,825:190,826:210,827:210,828:249,829:249,830:249,831:250,977:200,980:220,983:300,1061:190,1067:250,1070:250,1072:250,1075:200,1078:300,1081:300},
    region:[23,18],maxHeightDelta:6152,origin:[114000,16000,2000],
    sample:{id:812,name:'Archer of Despair',level:61,hostile:true,pAtk:2204,pDef:292,mAtk:505,mDef:307,hp:3137,exp:4708,sp:414,clan:'tower_ghost_clan',race:'undead'},
    sourceDropRows:473,importedItems:{4927:'Amulet: Chant of Revenge',4958:"Recipe: Zubei's Boots (60%)",4975:'Recipe: Necklace of Black Ore (70%)',4980:'Recipe: Doom Shield (60%)',4982:'Recipe: Blue Wolf Gaiters (60%)',4984:'Recipe: Blue Wolf Leather Armor (60%)',4985:'Recipe: Leather Armor of Doom (60%)',4990:'Recipe: Blue Wolf Helmet (60%)',5000:'Recipe: Sword of Damascus (60%)',5001:'Recipe: Lance (60%)',5005:'Recipe: Demon Dagger (60%)'},
    importedSkillRows:242,sourceSkillRows:242,
    combatSkills:{812:[4040],813:[4157,4160],815:[4072],816:[4033,4092,4067],817:[4155,4160,4118],818:[4032],819:[],820:[4072,4092,4032],821:[4100,4119,4047],822:[4046,4039],823:[4073],824:[4073],825:[4078,4069,4118],826:[4040],827:[4072,4032],828:[4046,4073,4066],829:[4033,4092,4073],830:[4033,4092,4073],831:[4072,4090,4232],977:[4087],980:[4073],983:[4073],1061:[4072,4090,4032],1062:[4033,4092,4073],1064:[4040],1065:[4073],1066:[4100,4039,4118],1067:[4033,4032],1069:[4073],1070:[4033,4092,4032],1072:[4158,4160,4102],1075:[4073],1078:[4072],1081:[4118]}
});
assertMonsterEmptyBeforeSlice({slug:'c4_tower_of_insolence',displayName:'Tower of Insolence',padding:0,zPadding:0,box:{minX:112049,maxX:117139,minY:13280,maxY:18562,minZ:-3644,maxZ:7992}});
