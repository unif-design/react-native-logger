const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');
const manifest = require('../package.json');

const root = path.resolve(__dirname, '..');
const condition = 'unif-react-native-logger-source';
for (const [name, entry] of Object.entries(manifest.exports)) {
  if (name === './package.json') continue;
  assert.ok(entry[condition], `${name} 缺少一致的开发源码条件`);
}

const configPath = path.join(root, 'example/tsconfig.json');
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(loaded.error, undefined);
const config = ts.parseJsonConfigFileContent(
  loaded.config,
  ts.sys,
  path.dirname(configPath),
  { noEmit: true },
  configPath,
);
const host = ts.createCompilerHost(config.options);
const fileExists = host.fileExists;
host.fileExists = (file) =>
  !path.resolve(file).startsWith(`${root}/lib/`) && fileExists(file);
const program = ts.createProgram(config.fileNames, config.options, host);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
assert.equal(
  diagnostics.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }),
);
console.log(
  '全部公共入口使用同一源码条件；示例在没有 lib 产物时通过类型检查。',
);
