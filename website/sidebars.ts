import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    'quick-start',
    {
      type: 'category',
      label: 'API 参考',
      collapsed: false,
      items: ['api/root', 'api/files'],
    },
    'format',
    'troubleshooting',
    'development',
  ],
};

export default sidebars;
