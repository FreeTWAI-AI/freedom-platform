export const POSTAL_SOURCE = Object.freeze({
  title: '臺灣地區郵遞區號前3碼一覽表',
  effective_date: '103.12.25',
  url: 'https://www.post.gov.tw/post/internet/Download/index.jsp?ID=220306',
  retrieved_date: '2026-10-15',
});

export const POSTAL_PREFIX_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [100, 100], [103, 106], [108, 108], [110, 112], [114, 116], [200, 212], [220, 224], [226, 228], [231, 239], [241, 244], [247, 249],
  [251, 253], [260, 270], [272, 272], [290, 290], [300, 300], [302, 308], [310, 315], [320, 320], [324, 328], [330, 330], [333, 338],
  [350, 354], [356, 358], [360, 369], [400, 404], [406, 408], [411, 414], [420, 424], [426, 429], [432, 439], [500, 500], [502, 516],
  [520, 528], [530, 530], [540, 542], [544, 546], [551, 553], [555, 558], [600, 600], [602, 608], [611, 616], [621, 625], [630, 638],
  [640, 640], [643, 643], [646, 649], [651, 655], [700, 702], [704, 704], [708, 727], [730, 737], [741, 745], [800, 807], [811, 815],
  [817, 817], [819, 833], [840, 840], [842, 849], [851, 852], [880, 885], [890, 894], [896, 896], [900, 909], [911, 913], [920, 929],
  [931, 932], [940, 947], [950, 959], [961, 966], [970, 979], [981, 983],
]);

export const OUTLYING_POSTAL_PREFIXES: ReadonlySet<string> = new Set([
  // 連江縣
  '209', '210', '211', '212',
  // 澎湖縣
  '880', '881', '882', '883', '884', '885',
  // 金門縣
  '890', '891', '892', '893', '894', '896',
  // 臺東縣
  '951', '952',
  // 屏東縣
  '929',
  // 南海諸島
  '817', '819',
  // 宜蘭縣
  '290',
]);

export function isKnownPostalPrefix(prefix: string): boolean {
  if (typeof prefix !== 'string' || !/^[0-9]{3}$/.test(prefix)) {
    return false;
  }
  const num = Number(prefix);
  return POSTAL_PREFIX_RANGES.some(([min, max]) => num >= min && num <= max);
}

export function isOutlyingPostalPrefix(prefix: string): boolean {
  if (typeof prefix !== 'string' || !/^[0-9]{3}$/.test(prefix)) {
    return false;
  }
  return OUTLYING_POSTAL_PREFIXES.has(prefix);
}
