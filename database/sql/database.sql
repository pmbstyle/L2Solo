DROP DATABASE IF EXISTS `nodel2`;
CREATE DATABASE `nodel2` COLLATE utf8_unicode_ci;
use `nodel2`

CREATE TABLE `accounts` (
    `username`    varchar(16) NOT NULL,
    `password`    varchar(16) NOT NULL,
    PRIMARY KEY (`username`)
);

CREATE TABLE `characters`(
    `id`          int( 8)     NOT NULL AUTO_INCREMENT,
    `username`    varchar(16) NOT NULL,
    `name`        varchar(16) NOT NULL,
    `title`       varchar(32) NOT NULL DEFAULT "",
    `classId`     int( 5)     NOT NULL,
    `race`        int( 5)     NOT NULL,
    `level`       int( 5)     NOT NULL DEFAULT 1,
    `hp`          float       NOT NULL DEFAULT 50,
    `maxHp`       float       NOT NULL,
    `mp`          float       NOT NULL DEFAULT 25,
    `maxMp`       float       NOT NULL,
    `cp`          float                NULL,
    `effects`     text                 NULL,
    `exp`         bigint      NOT NULL DEFAULT 0,
    `sp`          int(10)     NOT NULL DEFAULT 0,
    `pk`          int(10)     NOT NULL DEFAULT 0,
    `pvp`         int(10)     NOT NULL DEFAULT 0,
    `sex`         int( 5)     NOT NULL,
    `face`        int( 5)     NOT NULL,
    `hair`        int( 5)     NOT NULL,
    `hairColor`   int( 5)     NOT NULL,
    `karma`       int(10)     NOT NULL DEFAULT 0,
    `evalScore`   int( 5)     NOT NULL DEFAULT 0,
    `recRemain`   int( 5)     NOT NULL DEFAULT 0,
    `clanId`      int( 8)     NOT NULL DEFAULT 0,
    `clanPrivileges` int( 8) NOT NULL DEFAULT 0,
    `clanJoinExpiryTime` bigint NOT NULL DEFAULT 0,
    `clanCreateExpiryTime` bigint NOT NULL DEFAULT 0,
    `isGM`        boolean     NOT NULL DEFAULT 0,
    `isOnline`    boolean     NOT NULL DEFAULT 0,
    `isActive`    boolean     NOT NULL DEFAULT 1,
    `locX`        int(10)     NOT NULL,
    `locY`        int(10)     NOT NULL,
    `locZ`        int(10)     NOT NULL,
    `head`        int( 5)     NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`)
);
ALTER TABLE `characters` AUTO_INCREMENT=2000000;

CREATE TABLE `clans`(
    `id`          int( 8)     NOT NULL AUTO_INCREMENT,
    `name`        varchar(16) NOT NULL,
    `level`       int( 5)     NOT NULL DEFAULT 0,
    `leaderId`    int( 8)     NOT NULL,
    `crestId`     int( 8)     NOT NULL DEFAULT 0,
    `crestLargeId` int( 8)    NOT NULL DEFAULT 0,
    `allyId`      int( 8)     NOT NULL DEFAULT 0,
    `allyName`    varchar(16) NOT NULL DEFAULT "",
    `allyCrestId` int( 8)     NOT NULL DEFAULT 0,
    `dissolvingExpiryTime` bigint NOT NULL DEFAULT 0,
    `charPenaltyExpiryTime` bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`),
    UNIQUE KEY `name` (`name`),
    KEY `leaderId` (`leaderId`)
);

CREATE TABLE `clan_crests`(
    `id`          int( 8)     NOT NULL AUTO_INCREMENT,
    `clanId`      int( 8)     NOT NULL,
    `kind`        varchar(16) NOT NULL DEFAULT "pledge",
    `data`        varbinary(256) NOT NULL,
    `createdAt`   timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `clanId` (`clanId`)
);
ALTER TABLE `clans` AUTO_INCREMENT=6000000;

CREATE TABLE `items`(
    `id`          int( 8)     NOT NULL AUTO_INCREMENT,
    `selfId`      int( 5)     NOT NULL,
    `name`        varchar(48) NOT NULL,
    `amount`      int(20)     NOT NULL DEFAULT 1,
    `equipped`    boolean     NOT NULL DEFAULT 0,
    `slot`        int( 5)     NOT NULL DEFAULT 0,
    `petData`     text                 NULL,
    `characterId` int( 8)     NOT NULL,
    PRIMARY KEY (`id`)
);
ALTER TABLE `items` AUTO_INCREMENT=4000000;

CREATE TABLE `warehouse_items`(
    `id`          int( 8)     NOT NULL AUTO_INCREMENT,
    `selfId`      int( 5)     NOT NULL,
    `name`        varchar(48) NOT NULL,
    `amount`      bigint      NOT NULL DEFAULT 1,
    `petData`     text                 NULL,
    `characterId` int( 8)     NOT NULL,
    PRIMARY KEY (`id`),
    KEY `characterId` (`characterId`)
);

CREATE TABLE `skills`(
    `selfId`      int( 5)     NOT NULL,
    `name`        varchar(48) NOT NULL,
    `passive`     boolean     NOT NULL,
    `level`       int( 5)     NOT NULL,
    `characterId` int( 8)     NOT NULL
);

CREATE TABLE `shortcuts`(
    `id`          int( 8)     NOT NULL,
    `kind`        int( 5)     NOT NULL,
    `slot`        int( 5)     NOT NULL,
    `unknown`     int( 5)     NOT NULL,
    `characterId` int( 8)     NOT NULL
);

CREATE TABLE `macros`(
    `characterId` int( 8)     NOT NULL,
    `id`          int( 8)     NOT NULL,
    `icon`        tinyint unsigned NOT NULL,
    `name`        varchar(64) NOT NULL,
    `descr`       varchar(64) NOT NULL,
    `acronym`     varchar(16) NOT NULL,
    `commands`    text        NOT NULL,
    PRIMARY KEY (`characterId`, `id`),
    KEY `characterId` (`characterId`)
);
