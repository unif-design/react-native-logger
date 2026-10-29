// 共用生成规则源：unif-design/.github/templates/llms。
'use strict';

const SECTION_LABELS = new Map([
  ['概览', '概览'],
  ['getting-started', '开始使用'],
  ['components', '组件'],
  ['api', 'API'],
  ['guides', '使用指南'],
  ['native-setup', '原生接入'],
  ['design', '主题与设计'],
]);
const SECTION_ORDER = [
  '开始使用',
  '组件',
  'API',
  '使用指南',
  '原生接入',
  '主题与设计',
  '场景问题',
  '概览',
  'Optional',
];

function sectionFor(entry) {
  const file = entry.mdPath.split('/').at(-1).toLowerCase();
  if (['migration.md', 'skills.md', 'testing.md'].includes(file))
    return 'Optional';
  if (
    ['troubleshooting.md', 'platform-differences.md', 'faq.md'].includes(file)
  )
    return '场景问题';
  if (
    ['intro.md', 'unif-design.md', 'getting-started.md', 'readme.md'].includes(
      file
    )
  )
    return '开始使用';
  return SECTION_LABELS.get(entry.section) || entry.section;
}

function formatIndexLine(entry) {
  return entry.description
    ? `- [${entry.title}](${entry.mdPath}) — ${entry.description}`
    : `- [${entry.title}](${entry.mdPath})`;
}

function packageLabel(packageInfo) {
  if (
    !packageInfo ||
    typeof packageInfo !== 'object' ||
    Array.isArray(packageInfo) ||
    typeof packageInfo.name !== 'string' ||
    !packageInfo.name.trim() ||
    typeof packageInfo.version !== 'string' ||
    !packageInfo.version.trim() ||
    (packageInfo.description !== undefined &&
      typeof packageInfo.description !== 'string')
  ) {
    throw new Error(
      'Valid package name, version and optional description are required'
    );
  }
  return `${packageInfo.name}@${packageInfo.version}`;
}

function buildLlmsIndex(
  siteName,
  entries,
  packageInfo,
  { fullPath = 'llms-full.txt' } = {}
) {
  const sections = new Map();
  for (const entry of entries) {
    const section = sectionFor(entry);
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(entry);
  }
  if (fullPath) {
    if (!sections.has('Optional')) sections.set('Optional', []);
    sections.get('Optional').push({
      title: '完整全文',
      mdPath: fullPath,
      description: '仅在确需全局资料时读取；普通查询优先选择相关单页。',
    });
  }
  const label = packageLabel(packageInfo);
  const lines = [
    `# ${siteName}`,
    '',
    `> ${packageInfo.description || `${siteName} 使用文档与公开接口索引。`}`,
    '',
    `文档构建依据：\`${label}\`；使用时核对实际安装版本。`,
    '',
    '先查找当前功能，再读取对应 API、示例或 FAQ。源码链接供查阅，应用从包根公开接口导入。',
    '迁移、测试和研发技能按任务读取；这些资料不自动加入产品运行时模型上下文。',
    '',
  ];
  const rank = (section) => {
    const index = SECTION_ORDER.indexOf(section);
    return index === -1 ? SECTION_ORDER.length - 1 : index;
  };
  const names = [...sections.keys()].sort((a, b) =>
    a === 'Optional'
      ? 1
      : b === 'Optional'
        ? -1
        : rank(a) - rank(b) || a.localeCompare(b)
  );
  for (const name of names) {
    lines.push(`## ${name}`, '');
    for (const entry of sections.get(name)) lines.push(formatIndexLine(entry));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { buildLlmsIndex, formatIndexLine, packageLabel };
