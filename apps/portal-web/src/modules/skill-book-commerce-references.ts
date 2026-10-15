// Reviewed reading references, not installed dependencies or hosted capability claims.
// Source readback: Commerce planning pack v1.0 §§2/14, 2026-10-15.
export const commerceReadingReferences = [
  {
    repository: 'hsuanchi/EC-website-project',
    title: 'EC-website-project',
    attribution: 'GitHub 來源帳號：hsuanchi',
    commit: 'fd5d3c3ad28ae570991a7b2a002c6c9b7f93878f',
    role: '介面與購物流程參考',
    description: 'README 與展示圖片供理解購物、結帳及失敗恢復流程；收錄版本未提供應用程式原始碼。',
    license: null,
  },
  {
    repository: 'asgard-ai-platform/tw-ecommerce-majordomo',
    title: 'Taiwan E-Commerce Majordomo',
    attribution: '著作權標示：Asgard AI Platform',
    commit: '5dbab0cb341a7e113d0d51fbc6463b1a12481ece',
    role: '技能書與營運情境',
    description: '電商技能、操作情境與選用工具設定。部分 MCP 為私有服務，使用資格需另確認。',
    license: 'MIT',
  },
  {
    repository: 'Moksa1123/taiwan-ecommerce-toolkit',
    title: 'Taiwan E-Commerce Toolkit',
    attribution: '著作權標示：Taiwan Invoice Skills Contributors',
    commit: '5fde04410fbf91f7a091f5d9dbfa0734abf35a93',
    role: '金流、物流與發票介接參考',
    description: '文件、CLI 與程式範例供開發介接時參考；正式服務仍需商家核准帳戶及個別驗收。',
    license: 'MIT',
  },
] as const;

export function isStorefrontReading(bookId: string | undefined, upstream: string | null): boolean {
  if (bookId !== 'storefront' || !upstream) return false;
  try {
    const url = new URL(upstream);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port
      && /^\/FreeTWAI\/freedom-storefront\/?$/i.test(url.pathname);
  } catch { return false; }
}
