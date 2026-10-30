import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import '@unif/react-native-design/docs-home.css';

export default function Home(): ReactNode {
  return (
    <Layout
      title="结构化日志与文件诊断"
      description="供 React Native 应用与组件库共用的结构化日志、脱敏、身份分区与受控快照。"
    >
      <main className="unif-home logger-home">
        <section className="hp-hero logger-container">
          <span className="hp-eyebrow">Unif React Native</span>
          <h1 className="hp-title">
            结构化记录，
            <br />
            <span className="accent">按身份管理日志。</span>
          </h1>
          <p className="hp-tagline">
            记录应用与组件库的事件，关联同一次操作，过滤敏感字段，并按当前身份生成诊断快照。
          </p>
          <div className="hp-cta-row">
            <Link className="hp-btn hp-btn-primary" to="/docs/quick-start">
              快速开始
            </Link>
            <Link className="hp-btn hp-btn-outline" to="/docs/api/root">
              查看 API
            </Link>
          </div>
        </section>
        <section
          className="logger-container logger-features"
          aria-label="核心能力"
        >
          <article>
            <h2>结构化记录</h2>
            <p>
              应用提供事件与安全上下文，库统一处理时间、操作关联和诊断格式。
            </p>
            <Link to="/docs/format">阅读输出格式 →</Link>
          </article>
          <article>
            <h2>身份与脱敏</h2>
            <p>字段白名单、敏感内容处理和身份周期共同限定可记录的数据。</p>
            <Link to="/docs/api/root">了解日志契约 →</Link>
          </article>
          <article>
            <h2>受控文件</h2>
            <p>有界队列、轮转和快照所有权，连接应用已有的诊断分享流程。</p>
            <Link to="/docs/api/files">了解文件生命周期 →</Link>
          </article>
        </section>
        <section className="logger-container logger-example">
          <h2>宿主安装一次，各库记录自己的事件</h2>
          <pre>
            <code>{`import { createLogger } from '@unif/react-native-logger';

const log = createLogger('camera');
log.warn('capture.unavailable', {
  fields: { reason: 'permission_denied' },
});`}</code>
          </pre>
          <p>
            iOS／Android 使用原生文件适配。Web
            使用有界内存；原生文件写入、清理与分享需在仓库 example
            和真实设备中验证。
          </p>
          <Link to="/docs/development">查看原生示例与研发入口 →</Link>
        </section>
      </main>
    </Layout>
  );
}
