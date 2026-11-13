import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from '../src/service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
try {
  service = await startService({ source: source.url, directory });

  // 多轮交付：首轮接收 -> 二次交付（保留/替换/新增）-> 结构不合法 -> 源文变化。
  const rounds = [
    { kind: 'first', label: '首轮交付' },
    { kind: 'second', label: '二次交付' },
    { kind: 'broken', label: '代码身份损坏交付' },
    { kind: 'changed', label: '源文变更交付' },
  ];

  const summaries = [];
  for (const round of rounds) {
    const response = await fetch(`${service.url}/ingest?kind=${round.kind}&label=${encodeURIComponent(round.label)}`);
    const report = await response.json();
    if (!response.ok) {
      console.log(round.label, '失败', report);
      process.exitCode = 1;
      continue;
    }
    summaries.push({
      round: round.label,
      counts: report.counts,
      actionSummary: report.actionSummary,
      actions: report.actions.map(action => ({
        entryId: action.entryId,
        action: action.action,
        reasons: action.reasons,
        unit: action.current?.unit.id,
        fragment: action.current?.fragment.id,
      })),
    });
  }

  const registryResponse = await fetch(service.url + '/registry');
  const registry = await registryResponse.json();
  console.log(JSON.stringify({
    source: source.url,
    rounds: summaries,
    registry,
  }, null, 2));
  if (!registryResponse.ok) process.exitCode = 1;
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
