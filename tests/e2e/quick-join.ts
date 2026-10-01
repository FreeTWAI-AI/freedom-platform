import {expect, type Locator, type Page} from './fixtures.js';

/** Check the first option of every visible guild question. */
export async function answerGuildQuestions(root: Page | Locator) {
  const questions = root.locator('.guild-question');
  await expect(questions.first()).toBeVisible();
  const count = await questions.count();
  for (let index = 0; index < count; index += 1) await questions.nth(index).locator('input[type=radio]').first().check();
}

/** Select a guild, answer its entry questions, and submit quick start. */
export async function quickJoin(page: Page, guild = 'guild_ai_vibe') {
  const quick = page.getByRole('region', {name: '快速加入公會'});
  await expect(quick).toBeVisible();
  await quick.locator(`input[value="${guild}"]`).check();
  await quick.getByRole('button', {name: /下一步：回答 \d+ 個小問題/}).click();
  await answerGuildQuestions(quick);
  await quick.getByRole('button', {name: '加入公會，開始參與', exact: true}).click();
}
