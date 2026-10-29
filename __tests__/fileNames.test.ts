import {
  createLogFileName,
  isOwnedFileName,
  readLogFileName,
} from '../src/files/fileNames';

test.each(['log', 'snapshot'] as const)(
  '只识别当前生成的 %s 文件名和身份分区',
  (kind) => {
    const partition = 'a'.repeat(64);
    const name = createLogFileName(kind, partition, 1750000000000, 'test', 1);
    expect(readLogFileName(name, kind)).toEqual({
      partition,
      createdAt: 1750000000000,
    });
    expect(isOwnedFileName(name)).toBe(true);
  },
);

test.each([
  'log-anonymous-1750000000000-test.jsonl',
  'snapshot-anonymous-1750000000000-test.jsonl',
  'log-1750000000000-test.jsonl',
  'snapshot-1750000000000-test.jsonl',
  'unrelated.jsonl',
])('非当前命名的文件不归本日志模块管理：%s', (name) => {
  expect(readLogFileName(name, 'log')).toBeNull();
  expect(readLogFileName(name, 'snapshot')).toBeNull();
  expect(isOwnedFileName(name)).toBe(false);
});
