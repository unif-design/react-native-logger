import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Unif Logger',
  tagline: 'React Native 结构化日志与受控文件诊断',
  url: 'https://unif-design.github.io',
  baseUrl: '/react-native-logger/',
  organizationName: 'unif-design',
  projectName: 'react-native-logger',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  i18n: { defaultLocale: 'zh-Hans', locales: ['zh-Hans'] },
  presets: [
    [
      'classic',
      {
        docs: { path: '../docs', sidebarPath: './sidebars.ts' },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    colorMode: { defaultMode: 'light', respectPrefersColorScheme: true },
    navbar: {
      title: 'Unif Logger',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          label: '文档',
          position: 'left',
        },
        { to: '/docs/api/root', label: 'API', position: 'left' },
        {
          href: 'https://github.com/unif-design/react-native-logger',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: '文档',
          items: [
            { label: '快速开始', to: '/docs/quick-start' },
            { label: '输出格式', to: '/docs/format' },
            { label: '研发入口', to: '/docs/development' },
          ],
        },
        {
          title: '资源',
          items: [
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/@unif/react-native-logger',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/unif-design/react-native-logger',
            },
            { label: 'LLM 文档', href: 'pathname:///llms.txt' },
          ],
        },
        {
          title: 'Unif 生态',
          items: [
            { label: '文档总站', href: 'https://unif.design' },
            {
              label: 'Design',
              href: 'https://unif-design.github.io/react-native-design/',
            },
            {
              label: 'Camera',
              href: 'https://unif-design.github.io/react-native-camera/',
            },
            {
              label: 'HMS Scan',
              href: 'https://unif-design.github.io/react-native-hms-scan/',
            },
          ],
        },
      ],
      copyright: '@unif/react-native-logger · MIT',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ['bash', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
