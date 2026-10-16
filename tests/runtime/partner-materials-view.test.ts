import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PartnerMaterialsSchema,
  type PartnerMaterial,
  type PartnerMaterials,
} from '../../contracts/guild-launchpad/v1/supplier-console';
import {
  formatTaipeiTime,
  groupPartnerMaterials,
  materialAccessText,
  materialAppliesText,
  materialContentSummary,
  materialKindLabel,
  materialVersionText,
  partnerMaterialPath,
  partnerMaterialsErrorText,
} from '../../modules/agent-commerce/supplier-console/ui/partner/partner-materials';
import {
  PartnerMaterialsView,
} from '../../modules/agent-commerce/supplier-console/ui/partner/PartnerMaterials';
import { ApiError } from '../../apps/portal-web/src/api';

function renderPresentation(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
  try {
    return renderToStaticMarkup(element);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'React', previous);
    else Reflect.deleteProperty(globalThis, 'React');
  }
}

const tenantId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const prod1Id = '33333333-3333-4333-8333-333333333333';
const prod2Id = '44444444-4444-4444-8444-444444444444';
const mat1Id = '55555555-5555-4555-8555-555555555555';
const mat2Id = '66666666-6666-4666-8666-666666666666';
const mat3Id = '77777777-7777-4777-8777-777777777777';
const ver1Id = '88888888-8888-4888-8888-888888888888';
const ver2Id = '99999999-9999-4999-8999-999999999999';
const ver3Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const matCopy: PartnerMaterial = {
  material_id: mat1Id,
  kind: 'copy',
  supplier_name: '大地之寶',
  subject: { kind: 'brand' },
  applies_to: [prod1Id, prod2Id],
  title: '春季茶葉文案',
  description: '精選高山烏龍介紹文案\n四季適飲',
  access: 'public_use',
  current: {
    version_id: ver1Id,
    version_no: 1,
    created_at: '2026-10-15T15:30:00.000Z',
    content: {
      kind: 'copy',
      body: '這是一段精選的高山烏龍茶文案，回甘持久，香氣濃郁。',
    },
  },
};

const matImage: PartnerMaterial = {
  material_id: mat2Id,
  kind: 'image',
  supplier_name: '大地之寶',
  subject: {
    kind: 'product',
    product_id: prod1Id,
    title: '特選烏龍茶',
  },
  applies_to: [prod1Id],
  title: '特選烏龍茶正面商品照',
  description: '產品主視覺圖',
  access: 'partners',
  current: {
    version_id: ver2Id,
    version_no: 2,
    created_at: '2026-10-15T15:45:00.000Z',
    content: {
      kind: 'image',
      content_type: 'image/webp',
      byte_size: 819200, // 0.8 MB (<= 1048576 bytes)
      width: 1200,
      height: 800,
    },
  },
};

const matVideo: PartnerMaterial = {
  material_id: mat3Id,
  kind: 'video',
  supplier_name: '山嵐製菓',
  subject: {
    kind: 'product',
    product_id: prod2Id,
    title: '手工抹茶酥',
  },
  applies_to: [prod2Id],
  title: '抹茶酥烘焙過程展示',
  description: '烘焙坊實景短片',
  access: 'public_use',
  current: {
    version_id: ver3Id,
    version_no: 1,
    created_at: '2026-10-15T16:05:00.000Z',
    content: {
      kind: 'video',
      content_type: 'video/mp4',
      byte_size: 10485760, // 10.0 MB
    },
  },
};

const fixtureData: PartnerMaterials = {
  profile: 'freedom.partner-materials/v1',
  tenant_id: tenantId,
  instance_id: instanceId,
  as_of: '2026-10-15T15:30:00.000Z',
  items: [matCopy, matImage, matVideo],
  truncated: false,
};

test('M2-01 partner materials fixture passes PartnerMaterialsSchema.parse', () => {
  const parsed = PartnerMaterialsSchema.parse(fixtureData);
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.tenant_id, tenantId);
  assert.equal(parsed.instance_id, instanceId);
});

test('M2-02 partnerMaterialPath handles encoding and exact form', () => {
  const path = partnerMaterialPath(tenantId, instanceId, mat1Id, ver1Id);
  assert.equal(
    path,
    `/api/v1/tenants/${tenantId}/storefronts/${instanceId}/partner-materials/${mat1Id}/versions/${ver1Id}/content`,
  );

  const special = partnerMaterialPath('t/1', 'i 2', 'm:3', 'v@4');
  assert.equal(
    special,
    '/api/v1/tenants/t%2F1/storefronts/i%202/partner-materials/m%3A3/versions/v%404/content',
  );
});

test('M2-03 groupPartnerMaterials preserves server order, consecutive groups, brand first, first-seen products', () => {
  const matBrand2: PartnerMaterial = {
    ...matCopy,
    material_id: 'aaaaaaaa-1111-4111-8111-111111111111',
    title: '品牌文案二',
  };
  const matImageProd2: PartnerMaterial = {
    ...matImage,
    material_id: 'bbbbbbbb-2222-4222-8222-222222222222',
    subject: { kind: 'product', product_id: prod2Id, title: '第二商品' },
    applies_to: [prod2Id],
    title: '第二商品照',
  };
  const matSupplierASecondBatch: PartnerMaterial = {
    ...matCopy,
    material_id: 'cccccccc-3333-4333-8333-333333333333',
    supplier_name: '大地之寶',
    title: '非連續的大地之寶素材',
  };

  // Sequence: 大地之寶 (product1), 大地之寶 (brand), 大地之寶 (product2), 大地之寶 (product1 again), 山嵐製菓, 大地之寶
  const input = [
    matImage,
    matBrand2,
    matImageProd2,
    { ...matImage, material_id: 'dddddddd-4444-4444-8444-444444444444', title: '特選烏龍茶第二張照' },
    matVideo,
    matSupplierASecondBatch,
  ];

  const groups = groupPartnerMaterials(input);

  // Group 0: consecutive 大地之寶
  assert.equal(groups.length, 3);
  assert.equal(groups[0].supplier, '大地之寶');
  // Brand items must be first
  assert.equal(groups[0].brand.length, 1);
  assert.equal(groups[0].brand[0].title, '品牌文案二');
  // Products in first-seen order
  assert.equal(groups[0].products.length, 2);
  assert.equal(groups[0].products[0].productId, prod1Id);
  assert.equal(groups[0].products[0].title, '特選烏龍茶');
  assert.equal(groups[0].products[0].items.length, 2);
  assert.equal(groups[0].products[0].items[0].title, '特選烏龍茶正面商品照');
  assert.equal(groups[0].products[0].items[1].title, '特選烏龍茶第二張照');
  assert.equal(groups[0].products[1].productId, prod2Id);
  assert.equal(groups[0].products[1].title, '第二商品');

  // Group 1: 山嵐製菓
  assert.equal(groups[1].supplier, '山嵐製菓');
  assert.equal(groups[1].brand.length, 0);
  assert.equal(groups[1].products.length, 1);
  assert.equal(groups[1].products[0].productId, prod2Id);

  // Group 2: Non-consecutive 大地之寶 stays separate
  assert.equal(groups[2].supplier, '大地之寶');
  assert.equal(groups[2].brand.length, 1);
  assert.equal(groups[2].brand[0].title, '非連續的大地之寶素材');
});

test('M2-04 label helpers cover kinds, access values, brand vs product applies text', () => {
  assert.equal(materialKindLabel('image'), '圖片');
  assert.equal(materialKindLabel('video'), '影片');
  assert.equal(materialKindLabel('copy'), '文案');

  assert.equal(materialAccessText('public_use'), '供應商同意你把這個素材用在自己的公開店面。');
  assert.equal(materialAccessText('partners'), '僅供合作參考，供應商未同意放上公開店面。');

  assert.equal(
    materialAppliesText(matCopy),
    '品牌素材・適用你目前與這個供應商合作的 2 項商品',
  );
  assert.equal(
    materialAppliesText(matImage),
    '商品素材・特選烏龍茶',
  );
});

test('M2-05 materialVersionText and formatTaipeiTime convert UTC times near midnight to Asia/Taipei', () => {
  const previousTz = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/London']) {
      process.env.TZ = tz;
      // 2026-10-15T15:59:00.000Z is 23:59 Taipei
      const itemBeforeMidnight: PartnerMaterial = {
        ...matCopy,
        current: {
          ...matCopy.current,
          version_no: 3,
          created_at: '2026-10-15T15:59:00.000Z',
        },
      };
      assert.equal(
        materialVersionText(itemBeforeMidnight),
        '第 3 版・更新於 2026/10/15 23:59',
        `Failed in tz ${tz}`,
      );
      assert.equal(formatTaipeiTime('2026-10-15T15:59:00.000Z'), '23:59');

      // 2026-10-15T16:01:00.000Z is 00:01 next day in Taipei
      const itemAfterMidnight: PartnerMaterial = {
        ...matCopy,
        current: {
          ...matCopy.current,
          version_no: 4,
          created_at: '2026-10-15T16:01:00.000Z',
        },
      };
      assert.equal(
        materialVersionText(itemAfterMidnight),
        '第 4 版・更新於 2026/10/16 00:01',
        `Failed in tz ${tz}`,
      );
      assert.equal(formatTaipeiTime('2026-10-15T16:01:00.000Z'), '00:01');
    }
  } finally {
    if (previousTz !== undefined) process.env.TZ = previousTz;
    else delete process.env.TZ;
  }
});

test('M2-06 materialContentSummary handles image, video (MP4/WebM), MB rounding (>=0.1), and copy truncating', () => {
  // Image
  assert.equal(
    materialContentSummary({
      kind: 'image',
      content_type: 'image/webp',
      byte_size: 1572864, // 1.5 MB
      width: 1920,
      height: 1080,
    }),
    '1920 × 1080・1.5 MB',
  );

  // Small byte size rounds to minimum 0.1 MB
  assert.equal(
    materialContentSummary({
      kind: 'image',
      content_type: 'image/webp',
      byte_size: 100,
      width: 50,
      height: 50,
    }),
    '50 × 50・0.1 MB',
  );

  // Exact 1.0 MB
  assert.equal(
    materialContentSummary({
      kind: 'image',
      content_type: 'image/webp',
      byte_size: 1048576,
      width: 800,
      height: 600,
    }),
    '800 × 600・1.0 MB',
  );

  // Video MP4
  assert.equal(
    materialContentSummary({
      kind: 'video',
      content_type: 'video/mp4',
      byte_size: 20971520, // 20.0 MB
    }),
    'MP4・20.0 MB',
  );

  // Video WebM
  assert.equal(
    materialContentSummary({
      kind: 'video',
      content_type: 'video/webm',
      byte_size: 2621440, // 2.5 MB
    }),
    'WebM・2.5 MB',
  );

  // Copy <= 60 characters
  const shortBody = '這是少於六十個字元的文案。';
  assert.equal(
    materialContentSummary({ kind: 'copy', body: shortBody }),
    shortBody,
  );

  // Copy exactly 60 characters
  const exact60 = '一'.repeat(60);
  assert.equal(
    materialContentSummary({ kind: 'copy', body: exact60 }),
    exact60,
  );

  // Copy > 60 characters truncated with …
  const longBody = '一'.repeat(70);
  assert.equal(
    materialContentSummary({ kind: 'copy', body: longBody }),
    '一'.repeat(60) + '…',
  );
});

test('M2-07 view state: loading', () => {
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'loading' },
      tenantId,
      instanceId,
    }),
  );
  assert.ok(html.includes('合作素材'));
  assert.ok(html.includes('正在讀取合作素材…'));
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('r2'));
  assert.ok(!html.includes('bucket'));
  assert.ok(!html.includes('signed'));
});

test('M2-08 view state: failed without data shows error, retry, no 0 and no 沒有素材', () => {
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'failed', error: '遠端伺服器中斷' },
      tenantId,
      instanceId,
    }),
  );
  assert.ok(html.includes('目前無法讀取合作素材。 遠端伺服器中斷'));
  assert.ok(html.includes('重試'));
  assert.ok(!html.includes('0'));
  assert.ok(!html.includes('沒有素材'));
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('r2'));
  assert.ok(!html.includes('bucket'));
  assert.ok(!html.includes('signed'));
});

test('M2-09 view state: failed with stale data shows banner with Taipei time and renders items', () => {
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: {
        kind: 'failed',
        error: '網路連線失敗',
        staleData: fixtureData,
      },
      tenantId,
      instanceId,
      mediaEnabled: true,
    }),
  );
  // fixture as_of 2026-10-15T15:30:00.000Z is 23:30 in Asia/Taipei
  assert.ok(html.includes('顯示的是 23:30 的資料，最新讀取失敗。 網路連線失敗'));
  assert.ok(html.includes('重試'));
  // Items still rendered
  assert.ok(html.includes('大地之寶'));
  assert.ok(html.includes('春季茶葉文案'));
  assert.ok(html.includes('特選烏龍茶正面商品照'));
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('r2'));
  assert.ok(!html.includes('bucket'));
  assert.ok(!html.includes('signed'));
});

test('M2-10 view state: ready and empty', () => {
  const emptyData: PartnerMaterials = {
    ...fixtureData,
    items: [],
  };
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'ready', data: emptyData },
      tenantId,
      instanceId,
    }),
  );
  assert.ok(html.includes('資料時間 23:30'));
  assert.ok(html.includes('重新整理'));
  assert.ok(
    html.includes(
      '目前沒有供應商授權給這間店的素材。供應商授權後會出現在這裡；你停止販售或對方撤回後，素材會從這裡移除。',
    ),
  );
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('r2'));
  assert.ok(!html.includes('bucket'));
  assert.ok(!html.includes('signed'));
});

test('M2-11 view state: ready with items renders headings, badges, access texts, copy body, image, video, and final notice', () => {
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'ready', data: fixtureData },
      tenantId,
      instanceId,
      mediaEnabled: true,
    }),
  );

  // Headings
  assert.ok(html.includes('<h3>合作素材</h3>') || html.includes('合作素材'));
  assert.ok(html.includes('<h4>大地之寶</h4>'));
  assert.ok(html.includes('<h5>品牌素材</h5>'));
  assert.ok(html.includes('<h5>特選烏龍茶</h5>'));
  assert.ok(html.includes('<h4>山嵐製菓</h4>'));
  assert.ok(html.includes('<h5>手工抹茶酥</h5>'));

  // Badges
  assert.ok(html.includes('文案'));
  assert.ok(html.includes('圖片'));
  assert.ok(html.includes('影片'));

  // Access texts
  assert.ok(html.includes('供應商同意你把這個素材用在自己的公開店面。'));
  assert.ok(html.includes('僅供合作參考，供應商未同意放上公開店面。'));

  // Copy content & button
  assert.ok(html.includes('這是一段精選的高山烏龍茶文案，回甘持久，香氣濃郁。'));
  assert.ok(html.includes('複製文字'));

  // Image tag & attributes
  assert.ok(html.includes('<img'));
  assert.ok(
    html.includes(
      `src="/api/v1/tenants/${tenantId}/storefronts/${instanceId}/partner-materials/${mat2Id}/versions/${ver2Id}/content"`,
    ),
  );
  assert.ok(html.includes('width="1200"'));
  assert.ok(html.includes('height="800"'));
  assert.ok(html.includes('loading="lazy"'));

  // Video tag & attributes
  assert.ok(html.includes('<video'));
  assert.ok(html.includes('controls=""') || html.includes('controls'));
  assert.ok(html.includes('preload="metadata"'));
  assert.ok(
    html.includes(
      `src="/api/v1/tenants/${tenantId}/storefronts/${instanceId}/partner-materials/${mat3Id}/versions/${ver3Id}/content"`,
    ),
  );
  assert.ok(html.includes('MP4・10.0 MB'));

  // Download links
  assert.ok(html.includes('download=""') || html.includes('download'));
  assert.ok(html.includes('下載'));

  // Notice once under the list
  const noticeCount = html.split('素材的使用範圍以供應商的授權為準。已下載的檔案由你自行保管；供應商撤回或你停止合作後，這裡將不再提供。').length - 1;
  assert.equal(noticeCount, 1);

  // Security check: no external or storage address
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('r2'));
  assert.ok(!html.includes('bucket'));
  assert.ok(!html.includes('signed'));
});

test('M2-12 view state: mediaEnabled=false shows disclaimer for image and video, hides img/video, still displays copy text', () => {
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'ready', data: fixtureData },
      tenantId,
      instanceId,
      mediaEnabled: false,
    }),
  );

  // No img or video tags
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<video'));
  assert.ok(!html.includes('download'));

  // The disclaimer sentence appears
  assert.ok(html.includes('這個環境尚未開放素材檔案。'));

  // Copy text still displays
  assert.ok(html.includes('這是一段精選的高山烏龍茶文案，回甘持久，香氣濃郁。'));
  assert.ok(html.includes('複製文字'));

  // Security check
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('r2'));
  assert.ok(!html.includes('bucket'));
  assert.ok(!html.includes('signed'));
});

test('M2-13 view state: truncated shows notice', () => {
  const truncatedData: PartnerMaterials = {
    ...fixtureData,
    truncated: true,
  };
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'ready', data: truncatedData },
      tenantId,
      instanceId,
      mediaEnabled: true,
    }),
  );

  assert.ok(html.includes('只顯示前 200 筆素材。'));
  assert.ok(!html.includes('http://'));
  assert.ok(!html.includes('https://'));
  assert.ok(!html.includes('r2'));
  assert.ok(!html.includes('bucket'));
  assert.ok(!html.includes('signed'));
});

test('M2-14 error text helper: partnerMaterialsErrorText sanitizes ApiError and hides non-API errors', () => {
  // ApiError with detail
  const errWithDetail = new ApiError({
    message: '伺服器錯誤',
    detail: '資料庫維護中，請稍後重試',
    status: 503,
  });
  assert.equal(partnerMaterialsErrorText(errWithDetail), '資料庫維護中，請稍後重試');

  // ApiError without detail
  const errWithoutDetail = new ApiError({
    message: '找不到資源',
    status: 404,
  });
  assert.equal(partnerMaterialsErrorText(errWithoutDetail), '找不到資源');

  // ApiError with whitespace
  const errWhitespace = new ApiError({
    message: '   訊息前後有空格   ',
    detail: '   詳細說明前後有空格   ',
  });
  assert.equal(partnerMaterialsErrorText(errWhitespace), '詳細說明前後有空格');

  // ApiError with empty message and no detail
  const errEmpty = new ApiError({
    message: '   ',
  });
  assert.equal(partnerMaterialsErrorText(errEmpty), '');

  // ZodError from schema parse mismatch returns empty string
  const zodResult = PartnerMaterialsSchema.safeParse({});
  assert.ok(!zodResult.success);
  assert.equal(partnerMaterialsErrorText(zodResult.error), '');

  // Plain TypeError returns empty string
  assert.equal(partnerMaterialsErrorText(new TypeError('Cannot read properties of undefined')), '');

  // Plain Error returns empty string
  assert.equal(partnerMaterialsErrorText(new Error('Generic failure')), '');

  // Other types
  assert.equal(partnerMaterialsErrorText('string error'), '');
  assert.equal(partnerMaterialsErrorText(null), '');
  assert.equal(partnerMaterialsErrorText(undefined), '');
  assert.equal(partnerMaterialsErrorText({ detail: 'fake' }), '');
});

test('M2-15 duplicate React keys: non-consecutive same-name groups render both <h4> and trigger no console.error', () => {
  const nonConsecutiveItems: PartnerMaterial[] = [
    matCopy, // 大地之寶 (brand)
    matVideo, // 山嵐製菓 (product)
    {
      ...matCopy,
      material_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: '第二次的大地之寶素材',
    }, // 大地之寶 again (non-consecutive)
  ];

  const data: PartnerMaterials = {
    profile: 'freedom.partner-materials/v1',
    tenant_id: tenantId,
    instance_id: instanceId,
    as_of: '2026-10-15T15:30:00.000Z',
    items: nonConsecutiveItems,
    truncated: false,
  };

  const capturedErrors: any[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    capturedErrors.push(args);
    originalConsoleError(...args);
  };

  let html = '';
  try {
    html = renderPresentation(
      createElement(PartnerMaterialsView, {
        state: { kind: 'ready', data },
        tenantId,
        instanceId,
        mediaEnabled: true,
      }),
    );
  } finally {
    console.error = originalConsoleError;
  }

  // Assert no React console.error warnings (e.g. duplicate key warnings)
  assert.equal(
    capturedErrors.length,
    0,
    `Expected no console.error calls during render, but got: ${JSON.stringify(capturedErrors)}`,
  );

  // Assert both groups rendered with their <h4> headers
  const matchDadi = html.match(/<h4>大地之寶<\/h4>/g);
  assert.ok(matchDadi, 'Should find <h4>大地之寶</h4> in html');
  assert.equal(matchDadi.length, 2, 'Should render exactly two <h4>大地之寶</h4> headers for non-consecutive groups');

  const matchShan = html.match(/<h4>山嵐製菓<\/h4>/g);
  assert.ok(matchShan, 'Should find <h4>山嵐製菓</h4> in html');
  assert.equal(matchShan.length, 1);
});

test('M2-16 refresh state: refreshing=true shows 正在更新… status, disables 重新整理 button, and keeps data visible', () => {
  const html = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'ready', data: fixtureData, refreshing: true },
      tenantId,
      instanceId,
      mediaEnabled: true,
    }),
  );

  // Status indicator
  assert.ok(html.includes('正在更新…'));
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('資料時間 23:30'));

  // Button is disabled
  assert.ok(html.includes('disabled=""') || html.includes('disabled'));
  assert.ok(html.includes('重新整理'));

  // Existing data is still visible
  assert.ok(html.includes('大地之寶'));
  assert.ok(html.includes('春季茶葉文案'));
  assert.ok(html.includes('特選烏龍茶正面商品照'));
  assert.ok(html.includes('山嵐製菓'));
});

test('M2-17 refresh state: refreshing=false or omitted keeps 重新整理 button enabled without 正在更新…', () => {
  const htmlNotRefreshing = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'ready', data: fixtureData, refreshing: false },
      tenantId,
      instanceId,
      mediaEnabled: true,
    }),
  );

  assert.ok(!htmlNotRefreshing.includes('正在更新…'));
  assert.ok(htmlNotRefreshing.includes('資料時間 23:30'));
  // Button is NOT disabled
  assert.ok(!htmlNotRefreshing.includes('disabled'));
  assert.ok(htmlNotRefreshing.includes('重新整理'));

  const htmlOmitted = renderPresentation(
    createElement(PartnerMaterialsView, {
      state: { kind: 'ready', data: fixtureData },
      tenantId,
      instanceId,
      mediaEnabled: true,
    }),
  );

  assert.ok(!htmlOmitted.includes('正在更新…'));
  assert.ok(!htmlOmitted.includes('disabled'));
});
