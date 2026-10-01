export const GUILD_TOPIC_LABELS = {
  technology: 'AI 與技術', creation: '影音與創作', commerce: '商品與電商',
  community: '社群與活動', collaboration: '專案與合作', learning: '學習與探索',
} as const;
export type GuildTopic = keyof typeof GUILD_TOPIC_LABELS;
const topics: Record<string, GuildTopic[]> = {
  guild_talent_direction: ['learning','collaboration'],
  guild_product_quality_supply: ['commerce'], guild_commerce_sales: ['commerce'],
  guild_commerce_settlement: ['commerce','technology'], guild_marketing: ['commerce','creation'],
  guild_media_automation: ['creation','technology'], guild_member_operations: ['community'],
  guild_opportunity_partnership: ['collaboration','commerce'], guild_platform_engineering: ['technology'],
  guild_ai_vibe: ['technology'], guild_ai_field: ['technology','learning'],
  guild_ai_project: ['technology','collaboration'], guild_security: ['technology'],
  guild_music_mv: ['creation'], guild_commercial_production: ['creation','commerce'],
  guild_event_space: ['community','creation'], guild_projection_mapping: ['creation','technology'],
  guild_human_design: ['learning'],
};
export function guildTopics(guild: {guild_key:string;name:string;purpose:string}): GuildTopic[] {
  if (topics[guild.guild_key]) return [...topics[guild.guild_key]];
  const text = `${guild.name} ${guild.purpose}`;
  const rules: [GuildTopic, RegExp][] = [
    ['technology', /AI|程式|技術|開發|資安|自動化/i], ['creation', /影音|影片|音樂|創作|設計|攝影/],
    ['commerce', /商品|供應|電商|銷售|商店|行銷/], ['community', /社群|活動|空間|聚會/],
    ['collaboration', /合作|協作|專案|夥伴/], ['learning', /學習|共讀|探索|研究/],
  ];
  return rules.filter(([,pattern])=>pattern.test(text)).map(([key])=>key);
}
