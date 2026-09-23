-- Original specialist catalog additions. Existing members and leaders remain unchanged.
INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key,catalog_version) VALUES
('guild_event_space','event_space','活動與空間公會','策劃場地、空間動線、讀書會、聚會與實體活動的現場合作。','填一份活動與場地 brief，安排流程、角色與備援。','guilds',3),
('guild_projection_mapping','projection_mapping','光影光雕公會','協作光影、投影光雕、動態視覺與展演播放設計。','整理一份場勘紀錄、投影分區與播放 cue 表。','workbench',3),
('guild_human_design','human_design','人類圖研究所','以共讀、來源查核與不同觀點研究人類圖詮釋框架，不作診斷或能力定論。','用自己的話寫一份附來源、限制與反思問題的匿名共讀筆記。','guilds',3);
INSERT INTO positioning_track_catalog(track_key,name,description,guild_key,role_key,first_result,estimated_minutes,catalog_version) VALUES
('event_space_planner','活動與空間策劃者','整理場地承包需求、空間配置與現場分工。','guild_event_space','helper','一份活動場地 brief 與現場分工表',30,3),
('reading_club_producer','讀書會與聚會策劃者','安排共讀主題、場地、主持與交流流程。','guild_event_space','helper','一份可交接的讀書會流程與場地需求',20,3),
('projection_mapping_creator','光影光雕創作者','規劃投影表面、視覺素材與播放 cue。','guild_projection_mapping','creator','一份場勘、素材與播放交接表',30,3),
('human_design_reader','人類圖共讀者','整理來源、原創摘要、不同解讀與自願反思。','guild_human_design','helper','一份附來源與限制的匿名共讀紀錄',20,3);
