import { test, expect, type Page } from './fixtures.js';
import { Pool } from 'pg';
import { navigate,openPageTools } from './navigation.js';

const fixtureEnabled = process.env.FREEDOM_E2E_PRIVATE_AI_FIXTURE === '1';
test.describe('Social Post uses the existing isolated member model pipeline',()=>{
  test.skip(!fixtureEnabled,'Requires the existing isolated synthetic private-AI fixture; no real provider or account tokens.');
  for(const lostAck of [false,true])test(`one approved optimization previews copy and survives dialog close, lost execute ACK=${lostAck}`,async({page,e2eAuthPool})=>{
    await login(page);await readyStep(page,`合成測試：文案連線 ${lostAck}`);
    await page.goto('/#home');await page.getByRole('button',{name:'建立貼文',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'建立貼文',exact:true}),draft='這是本人真實草稿的合成演練，想找夥伴一起做作品。';
    const sent:string[]=[];let workId='';
    page.on('request',request=>{if(/\/me\/model-steps\/.+:execute$/.test(new URL(request.url()).pathname))sent.push(request.headers()['idempotency-key']);});
    page.on('response',async response=>{if(response.request().method()==='POST'&&response.url().endsWith('/me/private-work')&&response.ok())workId=(await response.json()).workId;});
    if(lostAck)await page.route('**/api/v1/me/model-steps/*:execute',async route=>{await route.fetch();await route.abort('failed');});
    await dialog.getByLabel('貼文內容',{exact:true}).fill(draft);
    await dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true}).click();
    await dialog.getByRole('combobox',{name:'我的模型',exact:true}).selectOption({index:1});
    await dialog.getByRole('button',{name:'同意送出草稿，優化一次',exact:true}).click();
    if(lostAck){
      await expect(dialog.getByRole('button',{name:'確認原請求結果',exact:true})).toBeVisible();
      await dialog.getByRole('button',{name:'關閉發文',exact:true}).click();
      await navigate(page,'社群分享');
      await page.getByRole('button',{name:'建立貼文',exact:true}).click();
      await dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true}).click();
      await dialog.getByRole('button',{name:'取回這次優化的原稿',exact:true}).click();
      await dialog.getByRole('button',{name:'確認原請求結果',exact:true}).click();
    }
    const preview=dialog.getByRole('region',{name:'優化文案預覽'});await expect(preview).toBeVisible();
    await expect(preview).toContainText('本機合成測試，未使用真實模型');
    await expect(dialog.getByLabel('貼文內容',{exact:true})).toHaveValue(draft);
    expect(sent).toHaveLength(1);expect(sent[0]).toBeTruthy();
    await expect.poll(async()=>Number((await e2eAuthPool.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1',[workId])).rows[0].n)).toBe(1);
    await dialog.getByRole('button',{name:'採用這版文案',exact:true}).click();
    await expect(dialog.getByLabel('貼文內容',{exact:true})).not.toHaveValue(draft);
    await dialog.getByRole('button',{name:'復原原稿',exact:true}).click();await expect(dialog.getByLabel('貼文內容',{exact:true})).toHaveValue(draft);
    expect(sent).toHaveLength(1);
    const saved=(await e2eAuthPool.query('SELECT objective FROM work_items WHERE work_item_id=$1',[workId])).rows[0].objective;
    expect(saved).toContain(JSON.stringify({draft}));
  });
});
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await navigate(page, '私人工作與 AI');
  await expect(page.getByRole('heading', { level: 1, name: '私人工作與 AI' })).toBeVisible();
  const tools = page.getByRole('group', { name: '私人工作與 AI頁面工具', exact: true });
  await openPageTools(page);
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
      await openPageTools(page);
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
  test('Stop reads fresh CAS and stays available while the execute request is pending', async ({ page, e2eAuthPool }) => {
    await login(page); await readyStep(page, '合成測試：送出中仍可停止');
    const stepId = await page.getByRole('combobox', { name: '推論狀態', exact: true }).inputValue();
    const before = (await e2eAuthPool.query('SELECT aggregate_version::text version FROM model_text_steps WHERE step_id=$1', [stepId])).rows[0].version;
    let release!: () => void, executes = 0, freshReads = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const stopped: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith(`/${stepId}:stop`)) stopped.push(request.headers()['if-match']);
      if (request.method() === 'GET' && request.url().endsWith(`/model-steps/${stepId}`)) freshReads++;
    });
    await page.route('**/api/v1/me/model-steps/*:execute', async route => { executes++; await held; await route.continue(); });
    try {
      await page.getByRole('button', { name: '執行一次推論', exact: true }).click();
      await expect.poll(() => executes).toBe(1);
      await expect(page.getByLabel('工作標題', { exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: '停止推論', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '停止推論', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: /已停止.*synthetic-text-model/ })).toBeVisible();
      expect(stopped).toEqual([`"${before}"`]); expect(freshReads).toBe(1);
      await page.getByRole('button', { name: '撤銷單次同意', exact: true }).click();
      await expect(page.getByRole('button', { name: '撤銷單次同意', exact: true })).toBeDisabled();
      expect(executes).toBe(1);
    } finally { release(); }
    await expect(page.getByLabel('工作標題', { exact: true })).toBeEnabled();
    expect((await e2eAuthPool.query('SELECT state FROM model_text_steps WHERE step_id=$1', [stepId])).rows[0].state).toBe('cancelled');
    await expect(page.locator('.private-ai-text')).toHaveCount(0);
  });
  test('a stale Stop button refreshes an already ended step without another control mutation', async ({ page, e2eAuthPool }) => {
    await login(page); await readyStep(page, '合成測試：其他裝置已停止');
    const stepId = await page.getByRole('combobox', { name: '推論狀態', exact: true }).inputValue();
    const version = (await e2eAuthPool.query('SELECT aggregate_version::text version FROM model_text_steps WHERE step_id=$1', [stepId])).rows[0].version;
    const session = await (await page.request.get('/api/v1/session')).json();
    const paused = await page.request.post(`/api/v1/me/model-steps/${stepId}:pause`, {
      headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': crypto.randomUUID(), 'If-Match': `"${version}"` }, data: {},
    });
    expect(paused.status()).toBe(200);
    let stops = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/${stepId}:stop`)) stops++; });
    await page.getByRole('button', { name: '停止推論', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '推論停止的對象已結束或撤銷' })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止推論', exact: true })).toBeDisabled();
    expect(stops).toBe(0);
  });
  test('unknown execute and unknown Stop retain independent exact replays while revocation remains available', async ({ page, e2eAuthPool }, testInfo) => {
    await login(page); await readyStep(page, '合成測試：兩個未確認請求');
    const workId = await page.getByRole('combobox', { name: '選擇私人工作', exact: true }).inputValue();
    const commands: Record<string, { key?: string; version?: string; body: string | null }[]> = { execute: [], stop: [] };
    await page.route('**/api/v1/me/model-steps/*:execute', async route => {
      const request = route.request(); commands.execute.push({ key: request.headers()['idempotency-key'], version: request.headers()['if-match'], body: request.postData() });
      if (commands.execute.length === 1) await route.fulfill({ status: 503, json: { code: 'synthetic_ambiguous_execute' } });
      else await route.fulfill({ response: await route.fetch() });
    });
    await page.route('**/api/v1/me/model-steps/*:stop', async route => {
      const request = route.request(); commands.stop.push({ key: request.headers()['idempotency-key'], version: request.headers()['if-match'], body: request.postData() });
      const response = await route.fetch();
      if (commands.stop.length === 1) await route.fulfill({ status: 503, json: { code: 'synthetic_ambiguous_stop' } });
      else await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '執行一次推論', exact: true }).click();
    await expect(page.getByRole('button', { name: '以原請求確認結果', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '停止推論', exact: true }).click();
    const retryStop = page.getByRole('button', { name: '以原控制請求確認推論停止', exact: true });
    await expect(retryStop).toBeVisible();
    await expect(page.getByRole('button', { name: '以原請求確認結果', exact: true })).toBeDisabled();
    await expect(page.getByLabel('工作標題', { exact: true })).toBeDisabled();
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height }); await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`private-ai-uncertain-controls-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '撤銷單次同意', exact: true }).click();
    await expect(page.getByRole('button', { name: '撤銷單次同意', exact: true })).toBeDisabled();
    await expect(retryStop).toBeVisible();
    await page.getByRole('button', { name: '撤銷模型同意', exact: true }).click();
    await expect(page.getByRole('button', { name: '撤銷模型同意', exact: true })).toBeDisabled();
    expect(commands.execute).toHaveLength(1);
    await retryStop.click(); await expect(retryStop).toHaveCount(0);
    expect(commands.stop).toHaveLength(2); expect(commands.stop[1]).toEqual(commands.stop[0]);
    await expect(page.getByRole('button', { name: '以原請求確認結果', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '以原請求確認結果', exact: true }).click();
    await expect(page.getByRole('button', { name: '以原請求確認結果', exact: true })).toHaveCount(0);
    expect(commands.execute).toHaveLength(2); expect(commands.execute[1]).toEqual(commands.execute[0]);
    expect((await e2eAuthPool.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1', [workId])).rows[0].n).toBe(0);
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

  test('owner edits append a human revision and unknown save replay retains the original intent', async ({ page }, testInfo) => {
    await login(page); await readyStep(page, '合成測試：本人修改成果');
    await page.getByRole('button', { name: '執行一次推論', exact: true }).click();
    await expect(page.getByRole('heading', { name: '第 1 版 · 模型產出', exact: true })).toBeVisible();
    const original=await page.locator('.private-ai-text').innerText();
    await page.getByRole('button', { name: '編輯成果', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存成果修改', exact: true })).toBeDisabled();
    const edited=original+'\n本人補充：這份成果經過我的修改。';
    await page.getByLabel('成果修改內容', { exact: true }).fill(edited);
    for(const [width,height] of [[1440,900],[768,1024],[390,844]]) {
      await page.setViewportSize({width,height});await page.getByLabel('成果修改內容', {exact:true}).scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:testInfo.outputPath(`result-editor-${width}.png`)});
    }
    const sent:{key:string|undefined;version:string|undefined;body:string|null}[]=[];
    await page.route('**/api/v1/me/private-work/*/results/*/edit', async route=>{
      const request=route.request();sent.push({key:request.headers()['idempotency-key'],version:request.headers()['if-match'],body:request.postData()});
      const actual=await route.fetch();expect(actual.status()).toBe(200);
      if(sent.length===1)await route.fulfill({status:503,json:{code:'synthetic_lost_result_ack'}});else await route.fulfill({response:actual});
    });
    await page.getByRole('button', { name: '保存成果修改', exact: true }).click();
    await expect(page.getByRole('button', { name: '以原請求確認結果', exact: true })).toBeVisible();
    await expect(page.getByLabel('成果修改內容', {exact:true})).toHaveValue(edited);
    await page.getByRole('button', { name: '重新讀取狀態', exact: true }).click();
    await expect(page.getByRole('heading', {name:'第 2 版 · 本人保存',exact:true})).toBeVisible();
    await expect(page.getByLabel('成果修改內容', {exact:true})).toHaveValue(edited);
    expect(sent).toHaveLength(1);
    await page.getByRole('button', { name: '以原請求確認結果', exact: true }).click();
    await expect(page.getByLabel('成果修改內容', {exact:true})).toHaveCount(0);
    expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
    await expect(page.locator('.private-ai-text')).toHaveText(edited);
    const versions=page.getByRole('combobox', {name:'成果版本',exact:true});await expect(versions.locator('option')).toHaveCount(3);
    await versions.selectOption({index:2});await expect(page.getByRole('heading', {name:'第 1 版 · 模型產出',exact:true})).toBeVisible();
    await expect(page.locator('.private-ai-text')).toHaveText(original);await expect(page.locator('.private-ai-panel')).toContainText('synthetic-text-model');
    expect(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('本人補充'))||Object.values(sessionStorage).some(value=>value.includes('本人補充')))).toBe(false);
  });

  test('same-key dispatched replay keeps editing locked while the original provider response is pending', async ({ page, e2eAuthPool }) => {
    await login(page);await readyStep(page,'合成測試：仍在處理的原請求');
    const stepId=await page.getByRole('combobox',{name:'推論狀態',exact:true}).inputValue();
    const workId=await page.getByRole('combobox',{name:'選擇私人工作',exact:true}).inputValue();
    const schema=(await e2eAuthPool.query('SELECT current_schema() name')).rows[0].name;
    const gatePool=new Pool({...e2eAuthPool.options,max:1}),holder=await gatePool.connect();
    await holder.query('BEGIN');const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`private-ai-browser-provider/${schema}`]);
    let observed!:()=>void;const providerBlocked=new Promise<void>(resolve=>{observed=resolve;});
    let original:Promise<unknown>|undefined,requests=0,freshReads=0;const replayStates:string[]=[],sent:{key?:string;version?:string;body:string|null}[]=[];
    page.on('request',request=>{if(request.method()==='GET'&&request.url().endsWith(`/model-steps/${stepId}`))freshReads++;});
    await page.route('**/api/v1/me/model-steps/*:execute',async route=>{
      const request=route.request();sent.push({key:request.headers()['idempotency-key'],version:request.headers()['if-match'],body:request.postData()});
      requests++;if(requests===1){original=route.fetch().catch(()=>undefined);await providerBlocked;await route.fulfill({status:503,json:{code:'synthetic_original_still_pending'}});}
      else{const actual=await route.fetch();expect(actual.status()).toBe(200);replayStates.push((await actual.json()).state);await route.fulfill({response:actual});}
    });
    try{
      await page.getByRole('button',{name:'執行一次推論',exact:true}).click();
      await expect.poll(async()=>Number((await e2eAuthPool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n)).toBe(1);
      observed();const replay=page.getByRole('button',{name:'以原請求確認結果',exact:true});await expect(replay).toBeVisible();
      await replay.click();await expect.poll(()=>replayStates.length).toBe(1);expect(replayStates).toEqual(['dispatched']);
      await expect.poll(()=>freshReads).toBe(1);await expect(replay).toBeEnabled();
      await expect(page.getByLabel('工作標題',{exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'新增私人工作',exact:true})).toBeDisabled();
      await expect(page.getByRole('button',{name:'停止推論',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'撤銷單次同意',exact:true})).toBeEnabled();
      expect(requests).toBe(2);expect(sent[1]).toEqual(sent[0]);await page.getByRole('button',{name:'停止推論',exact:true}).click();
      await expect(page.getByRole('status').filter({hasText:/推論停止已保存/})).toBeVisible();
      expect((await e2eAuthPool.query('SELECT state FROM model_text_steps WHERE step_id=$1',[stepId])).rows[0].state).toBe('outcome_unknown');
    } finally {observed();await holder.query('COMMIT');holder.release();await gatePool.end();await original;}
    expect((await e2eAuthPool.query('SELECT count(*)::int n FROM private_model_work_results WHERE work_item_id=$1',[workId])).rows[0].n).toBe(0);
  });

});
