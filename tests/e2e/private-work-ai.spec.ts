import { test, expect, type Page } from './fixtures.js';
import { navigate } from './navigation.js';

const fixtureEnabled = process.env.FREEDOM_E2E_PRIVATE_AI_FIXTURE === '1';
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await navigate(page, '私人工作與 AI');
  await expect(page.getByRole('heading', { level: 1, name: '私人工作與 AI' })).toBeVisible();
  const tools = page.getByRole('group', { name: '私人工作與 AI頁面工具', exact: true });
  await expect(tools.getByRole('button')).toHaveCount(3);
  for (const name of ['提出想法', '頁面說明', '參與編修']) await expect(tools.getByRole('button', { name, exact: true })).toBeVisible();
}
async function readyStep(page: Page, title: string) {
  await page.getByRole('button', { name: '新增私人工作', exact: true }).click();
  await page.getByLabel('工作標題', { exact: true }).fill(title);
  await page.getByLabel('工作目標', { exact: true }).fill('合成私人的測試目標，只允許單次模型推論。');
  await page.getByRole('button', { name: '建立私人工作', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '選擇私人工作', exact: true })).not.toHaveValue('');
  await expect(page.getByRole('button', { name: '建立執行紀錄', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '建立執行紀錄', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '執行紀錄', exact: true })).not.toHaveValue('');
  await page.getByRole('combobox', { name: '已配對的執行連線', exact: true }).selectOption({ index: 1 });
  await page.getByText('新增模型選擇紀錄', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: '供應商與模型', exact: true })).toHaveValue('');
  await page.getByRole('combobox', { name: '供應商與模型', exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: '保存模型選擇', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '已保存的模型選擇', exact: true })).not.toHaveValue('');
  const grantConsent = page.getByRole('checkbox', { name: '我同意將此工作版本綁定至選定的執行連線與模型。' });
  await expect(grantConsent).toBeEnabled(); await grantConsent.check();
  await page.getByRole('button', { name: '保存模型同意', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模型同意紀錄', exact: true })).not.toHaveValue('');
  const exportPanel = page.locator('.private-ai-export');
  await expect(exportPanel).toContainText(title);
  await expect(exportPanel).toContainText('合成私人的測試目標，只允許單次模型推論。');
  await expect(exportPanel).toContainText('synthetic-text-model');
  await expect(page.getByRole('button', { name: '確認單次推論同意', exact: true })).toBeDisabled();
  await page.getByLabel('最多輸出 token', { exact: true }).fill('64');
  await page.getByRole('checkbox', { name: /我同意以上已保存的標題與目標/ }).check();
  await page.getByRole('button', { name: '確認單次推論同意', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '單次推論同意', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: '啟用這次推論', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '推論狀態', exact: true })).not.toHaveValue('');
  await expect(page.getByRole('button', { name: '執行一次推論', exact: true })).toBeEnabled();
}

test('the unconfigured member page reports unavailable service without model login or a fake ready state', async ({ page }) => {
  test.skip(fixtureEnabled, 'This checks the default unconfigured product composition.');
  await login(page);
  await expect(page.getByText('模型執行服務目前無法使用。尚未確認供應商登入、模型可用性或費用。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '執行一次推論', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.describe('isolated SQL and loopback synthetic model fixture', () => {
  test.skip(!fixtureEnabled, 'Requires FREEDOM_E2E_PRIVATE_AI_FIXTURE=1; never accesses a real provider.');
  test('a member explicitly approves exact context, executes once and reads provenance with responsive navigation', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', value => errors.push(value.message));
    const executes: { key: string | undefined; version: string | undefined; body: string | null }[] = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/me\/model-steps\/.+:execute$/.test(new URL(request.url()).pathname)) executes.push({ key: request.headers()['idempotency-key'], version: request.headers()['if-match'], body: request.postData() }); });
    await login(page);
    await page.getByRole('button', { name: '頁面說明', exact: true }).click();
    const help = page.getByRole('dialog', { name: '私人工作與 AI：頁面說明', exact: true });
    await expect(help).toBeVisible();
    await expect(help.getByRole('heading', { name: '這一頁是什麼', exact: true })).toBeVisible();
    await expect(help.locator('.page-tools-lead')).toHaveText('私人工作與 AI 讓你建立、修改本人的工作草稿，逐次確認模型推論送出的內容，並閱讀私人產出的成果。');
    await expect(help.locator('.page-tools-help-steps')).toContainText('標題、目標、供應商、模型與輸出上限');
    await expect(help.locator('.page-tools-help-steps')).toContainText('目前成果與歷史');
    await expect(help.locator('.page-tools-help-steps')).toContainText('以原請求確認結果');
    await expect(help.locator('.page-tools-note')).toContainText('費用未知');
    await help.getByRole('button', { name: '關閉', exact: true }).click();
    await expect(help).toHaveCount(0);
    await readyStep(page, '合成測試：私人模型成果');
    await page.getByRole('button', { name: '執行一次推論', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /已完成.*synthetic-text-model/ })).toBeVisible();
    await expect(page.locator('.private-ai-text')).not.toBeEmpty();
    await expect(page.getByRole('heading', { name: '第 1 版 · 模型產出', exact: true })).toBeVisible();
    await expect(page.locator('.private-ai-panel')).toContainText('本機合成測試，未呼叫真實供應商');
    await expect(page.locator('.private-ai-panel')).toContainText('費用未知');
    await expect(page.getByRole('button', { name: '執行一次推論', exact: true })).toBeDisabled();
    expect(executes).toHaveLength(1); expect(executes[0].key).toBeTruthy(); expect(executes[0].version).toMatch(/^"\d+"$/); expect(executes[0].body).toBe('{}');
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => scrollTo(0, 0));
      for (const name of ['提出想法', '頁面說明', '參與編修']) await expect(page.getByRole('group', { name: '私人工作與 AI頁面工具', exact: true }).getByRole('button', { name, exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`private-ai-${width}.png`), fullPage: true });
      await page.screenshot({ path: testInfo.outputPath(`private-ai-viewport-${width}.png`) });
    }
    const stored = await page.evaluate(() => Object.entries(localStorage).concat(Object.entries(sessionStorage)));
    expect(JSON.stringify(stored)).not.toContain('合成測試：私人模型成果');
    expect(JSON.stringify(stored)).not.toContain('合成私人的測試目標');
    expect(errors).toEqual([]);
    await page.reload();
    await expect(page.getByRole('combobox', { name: '既有推論', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '既有推論', exact: true }).selectOption({ index: 1 });
    await expect(page.getByRole('status').filter({ hasText: /已完成/ })).toBeVisible();
    expect(executes).toHaveLength(1);
  });
  test('an uncertain execute response freezes new mutations and explicit replay uses the same key and version', async ({ page }) => {
    await login(page); await readyStep(page, '合成測試：回應遺失');
    const sent: { key: string | undefined; version: string | undefined; body: string | null }[] = [];
    await page.route('**/api/v1/me/model-steps/*:execute', async route => {
      const request = route.request(); sent.push({ key: request.headers()['idempotency-key'], version: request.headers()['if-match'], body: request.postData() });
      const actual = await route.fetch();
      if (sent.length === 1) await route.fulfill({ status: 503, json: { code: 'synthetic_lost_response' } });
      else await route.fulfill({ response: actual });
    });
    await page.getByRole('button', { name: '執行一次推論', exact: true }).click();
    await expect(page.getByRole('button', { name: '以原請求確認結果', exact: true })).toBeVisible();
    expect(sent).toHaveLength(1);
    await expect(page.getByLabel('工作標題', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重新讀取狀態', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /已完成/ })).toBeVisible();
    expect(sent).toHaveLength(1);
    await page.getByRole('button', { name: '以原請求確認結果', exact: true }).click();
    await expect(page.getByRole('button', { name: '以原請求確認結果', exact: true })).toHaveCount(0);
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
    await expect(page.getByRole('combobox', { name: '成果版本', exact: true })).toContainText('第 1 版');
    await expect(page.getByRole('combobox', { name: '成果版本', exact: true })).not.toContainText('第 2 版');
  });
  test('a member can stop a reserved step and revoke its consent records', async ({ page }) => {
    await login(page); await readyStep(page, '合成測試：停止與撤銷');
    await page.getByRole('button', { name: '停止推論', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /已停止.*synthetic-text-model/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '執行一次推論', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '撤銷單次同意', exact: true }).click();
    await expect(page.getByRole('button', { name: '撤銷單次同意', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '撤銷模型同意', exact: true }).click();
    await expect(page.getByRole('button', { name: '撤銷模型同意', exact: true })).toBeDisabled();
    await expect(page.locator('.private-ai-text')).toHaveCount(0);
  });
  test('withdrawn persistence hides private content while metadata still supports stopping and revocation after reload', async ({ page, e2eAuthPool }) => {
    await login(page); await readyStep(page, '合成測試：政策撤回後控制');
    const workId = await page.getByRole('combobox', { name: '選擇私人工作', exact: true }).inputValue();
    const selectedStep = await page.getByRole('combobox', { name: '推論狀態', exact: true }).inputValue();
    const selectedApproval = await page.getByRole('combobox', { name: '單次推論同意', exact: true }).inputValue();
    const selectedGrant = await page.getByRole('combobox', { name: '模型同意紀錄', exact: true }).inputValue();
    const policy = (await e2eAuthPool.query('SELECT p.scope_id,p.purpose FROM private_work_persistence_policy p JOIN work_items w ON w.scope_id=p.scope_id WHERE w.work_item_id=$1', [workId])).rows[0];
    expect(policy).toBeTruthy();
    await e2eAuthPool.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=false WHERE scope_id=$1 AND purpose=$2', [policy.scope_id, policy.purpose]);
    try {
      await page.getByRole('button', { name: '重新讀取狀態', exact: true }).click();
      await expect(page.getByText('私人內容儲存政策目前未開放。工作內容與成果暫不顯示；仍可讀取推論狀態、停止或撤銷同意。', { exact: true })).toBeVisible();
      await expect(page.getByLabel('工作標題', { exact: true })).toHaveCount(0);
      await expect(page.locator('.private-ai-panel')).not.toContainText('合成測試：政策撤回後控制');
      await expect(page.getByRole('button', { name: '新增私人工作', exact: true })).toBeDisabled();
      await page.reload();
      await page.getByRole('combobox', { name: '既有推論', exact: true }).selectOption(selectedStep);
      await page.getByRole('button', { name: '停止推論', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: /已停止/ })).toBeVisible();
      await page.getByRole('combobox', { name: '既有單次同意', exact: true }).selectOption(selectedApproval);
      await page.getByRole('button', { name: '撤銷單次同意', exact: true }).click();
      await expect(page.getByRole('button', { name: '撤銷單次同意', exact: true })).toBeDisabled();
      await page.getByRole('combobox', { name: '既有模型同意', exact: true }).selectOption(selectedGrant);
      await page.getByRole('button', { name: '撤銷模型同意', exact: true }).click();
      await expect(page.getByRole('button', { name: '撤銷模型同意', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '執行一次推論', exact: true })).toHaveCount(0);
    } finally {
      await e2eAuthPool.query('UPDATE private_work_persistence_policy SET revision=revision+1,persistence_allowed=true WHERE scope_id=$1 AND purpose=$2', [policy.scope_id, policy.purpose]);
    }
  });

  test('withdrawn export policy shows no invented token allowance and does not enable a new approval', async ({ page, e2eAuthPool }) => {
    await login(page); await readyStep(page, '合成測試：模型政策撤回');
    const workId = await page.getByRole('combobox', { name: '選擇私人工作', exact: true }).inputValue();
    const policy = (await e2eAuthPool.query('SELECT p.policy_id FROM model_inference_export_policy p JOIN work_items w ON w.scope_id=p.scope_id WHERE w.work_item_id=$1', [workId])).rows[0];
    expect(policy).toBeTruthy();
    await e2eAuthPool.query('UPDATE model_inference_export_policy SET revision=revision+1,export_allowed=false WHERE policy_id=$1', [policy.policy_id]);
    try {
      await page.getByRole('button', { name: '重新讀取狀態', exact: true }).click();
      await expect(page.getByText('目前沒有允許此模型推論的政策，無法建立新的單次同意。', { exact: true })).toBeVisible();
      await expect(page.getByLabel('最多輸出 token', { exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '確認單次推論同意', exact: true })).toBeDisabled();
      await expect(page.locator('.private-ai-panel')).not.toContainText('目前政策上限 4096');
      await expect(page.getByLabel('工作標題', { exact: true })).toHaveValue('合成測試：模型政策撤回');
      await page.getByRole('button', { name: '停止推論', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: /已停止/ })).toBeVisible();
    } finally {
      await e2eAuthPool.query('UPDATE model_inference_export_policy SET revision=revision+1,export_allowed=true WHERE policy_id=$1', [policy.policy_id]);
    }
  });

});
