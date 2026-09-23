-- Add only the three requested professional guilds. Existing primary guilds and
-- memberships are preserved; an officer is never inferred from repo authorship.
INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key,catalog_version) VALUES
('guild_security','security','資安公會','針對自己有權管理的系統，整理安全檢查、風險與修復驗證。','Fork 資安掃描技能書，先記錄授權範圍與可重現的檢查結果。','opensource',2),
('guild_music_mv','music_mv','音樂創作與MV公會','把歌曲構想、聲音製作與影像敘事整理成可交付的音樂與 MV。','使用入門手冊完成一份歌曲與 MV 企劃，列清素材來源。','opensource',2),
('guild_commercial_production','commercial_production','廣告攝影與影片公會','釐清商業影像需求，協作完成商品攝影、廣告影片與交付版本。','使用入門手冊完成一份廣告拍攝 brief、分鏡與交付清單。','marketing',2);
INSERT INTO positioning_track_catalog(track_key,name,description,guild_key,role_key,first_result,estimated_minutes,catalog_version) VALUES
('security_practitioner','資安檢查協作者','在明確授權範圍內進行安全檢查與修復驗證。','guild_security','helper','一份有範圍與重現步驟的安全檢查紀錄',30,2),
('music_mv_creator','音樂與 MV 創作者','規劃歌曲、聲音、素材來源與 MV 故事。','guild_music_mv','creator','一份歌曲與 MV 製作企劃',30,2),
('commercial_producer','商業攝影與影片創作者','整理商家需求、拍攝腳本與交付規格。','guild_commercial_production','creator','一份廣告拍攝企劃與交付清單',30,2);
