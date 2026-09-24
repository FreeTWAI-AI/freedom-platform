// Classify only explicit GitHub labels; titles and bodies are not status evidence.
export const taskCategories = [
  ['bug', 'Bug 修復'], ['feature', '功能改善'], ['testing', '測試'],
  ['documentation', '文件教學'], ['design', '設計'], ['security', '資安'],
  ['collaboration', '推廣與協作'], ['unclassified', '未分類'],
] as const;
export type TaskCategory = typeof taskCategories[number][0];
const labels: Record<string, TaskCategory> = {
  bug: 'bug', defect: 'bug', '錯誤': 'bug', '修復': 'bug',
  enhancement: 'feature', feature: 'feature', '功能': 'feature', '功能改善': 'feature',
  test: 'testing', tests: 'testing', testing: 'testing', '測試': 'testing',
  docs: 'documentation', documentation: 'documentation', '文件': 'documentation',
  design: 'design', '設計': 'design', security: 'security', '資安': 'security',
  marketing: 'collaboration', outreach: 'collaboration', operations: 'collaboration', '推廣': 'collaboration', '協作': 'collaboration',
};
export function categoriesForLabels(values: string[]): TaskCategory[] {
  const matches = [...new Set(values.flatMap(value => {
    const key = value.trim().toLowerCase().replace(/^(?:type|kind)\s*[:/]\s*/, '');
    return Object.hasOwn(labels, key) ? [labels[key]] : [];
  }))];
  return matches.length ? matches : ['unclassified'];
}
