import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptStore } from '../src/store.mjs';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('接收记录支持同内容重复领取并拒绝覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipt-'));
  try {
    const store = new ReceiptStore(directory);
    assert.deepEqual(await store.save('one', { value: 3 }), await store.save('one', { value: 3 }));
    await assert.rejects(store.save('one', { value: 4 }), /冲突/);
    await assert.rejects(store.save('../escape', {}), /无效/);
    const receipt = JSON.parse(await readFile(join(directory, 'one.json'), 'utf8'));
    receipt.value.value = 8;
    await writeFile(join(directory, 'one.json'), JSON.stringify(receipt));
    await assert.rejects(store.read('one'), /校验失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('服务健康检查和单次查看走真实来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    assert.equal((await (await fetch(service.url + '/health')).json()).state, 'ready');
    const response = await fetch(service.url + '/inspect');
    assert.equal(response.status, 200, await response.text());
    assert.equal((await fetch(service.url + '/missing')).status, 404);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('接收接口返回三类分桶并在多轮交付后解释每条裁决', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ingest-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    const first = await (await fetch(service.url + '/ingest?kind=first&label=' + encodeURIComponent('首轮'))).json();
    assert.equal(first.counts.accepted, 2);
    assert.equal(first.counts.pending, 2);
    assert.equal(first.counts.invalid, 0);

    const second = await (await fetch(service.url + '/ingest?kind=second')).json();
    const s2 = second.actions.find(a => a.current.fragment.id === 's2');
    assert.equal(s2.action, 'replaced');
    const s1 = second.actions.find(a => a.current.fragment.id === 's1');
    assert.equal(s1.action, 'retained');

    const broken = await (await fetch(service.url + '/ingest?kind=broken')).json();
    assert.equal(broken.counts.invalid, 1);
    const blocked = broken.actions.find(a => a.current.fragment.id === 's1');
    assert.equal(blocked.action, 'blocked');
    assert.ok(blocked.reasons.some(r => r.code === 'structurally-invalid'));

    const registry = await (await fetch(service.url + '/registry')).json();
    assert.equal(registry.history.length, 3);
    assert.ok(registry.entries.some(e => e.fragment.id === 's1'));

    // 重启服务后注册表从磁盘恢复。
    await service.close();
    const restarted = await startService({ source: fixture.url, directory });
    try {
      const reloaded = await (await fetch(restarted.url + '/registry')).json();
      assert.equal(reloaded.history.length, 3);
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('结构不合法交付以正常分桶返回并阻止录入，注册表保持可追溯', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'badxml-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    await fetch(service.url + '/ingest?kind=first');
    const response = await fetch(service.url + '/ingest?kind=broken');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.counts.invalid, 1);
    const act = body.actions.find(a => a.current.fragment.id === 's1');
    assert.equal(act.action, 'blocked');
    const registry = await (await fetch(service.url + '/registry')).json();
    const s1 = registry.entries.find(e => e.fragment.id === 's1');
    assert.equal(s1.outcome, 'accepted'); // 旧已接收译文未被覆盖
    assert.equal(s1.blockedPending, true);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
