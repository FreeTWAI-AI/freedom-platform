import { z } from 'zod';

export const communitySearchTopics = ['intro', 'showcase', 'help', 'tools', 'gathering'] as const;
export const communitySearchKinds = ['post', 'work', 'skill_book', 'event'] as const;
export const communitySearchTopicLabels: Record<typeof communitySearchTopics[number], string> = {
  intro: '入門教學', showcase: '設計作品', help: '求助問答', tools: '工具資源', gathering: '社群交流',
};
export const communitySearchKindLabels: Record<typeof communitySearchKinds[number], string> = {
  post: '貼文', work: '作品', skill_book: '技能書', event: '活動',
};

export const communitySearchItemSchema = z.object({
  kind: z.enum(communitySearchKinds),
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  path: z.string(),
  label: z.string().nullable(),
  author_id: z.string().nullable().optional(),
  media_path: z.string().nullable(),
  topics: z.array(z.enum(communitySearchTopics)),
}).strict();
export const communitySearchPageSchema = z.object({
  items: z.array(communitySearchItemSchema),
  next_cursor: z.string().nullable(),
}).strict();
export type CommunitySearchPage = z.infer<typeof communitySearchPageSchema>;
