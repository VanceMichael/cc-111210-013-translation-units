import { listen, get } from './http.mjs';
import { inspect } from './connector.mjs';
import { parseXliff } from './xliff.mjs';
import { processDelivery } from './reception.mjs';
import { ReceiptStore } from './store.mjs';
import { RegistryStore } from './registry.mjs';

async function fetchXliff(source, kind) {
  const response = await get(source, '/labels.xlf?kind=' + encodeURIComponent(kind ?? 'first'));
  return response.text();
}

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  const registryStore = new RegistryStore(directory);

  return listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };

    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }

    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }

    // 翻译单元接收：结构解析、代码配对、状态闸门与三类分桶。
    if (url.pathname === '/ingest') {
      const kind = url.searchParams.get('kind') ?? 'first';
      const label = url.searchParams.get('label');
      const xml = await fetchXliff(source, kind);
      const doc = parseXliff(xml);
      const report = processDelivery(doc, { kind, label });
      const registry = await registryStore.load();
      const decided = registry.ingest(report);
      await registryStore.save(registry);
      return { body: decided };
    }

    // 注册表当前状态与每次交付的裁决历史。
    if (url.pathname === '/registry') {
      const registry = await registryStore.load();
      return { body: { entries: registry.snapshot(), history: registry.history } };
    }

    if (url.pathname.startsWith('/receipts/')) {
      return { body: await store.read(url.pathname.split('/').pop()) };
    }

    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
