import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXliff } from '../src/xliff.mjs';
import { ACTION, OUTCOME, processDelivery, REASONS } from '../src/reception.mjs';
import { TranslationRegistry } from '../src/registry.mjs';
import { labels, labelsFor } from '../fixtures/source.mjs';

const X = 'urn:oasis:names:tc:xliff:document:2.0';
const xliff = body => `<?xml version="1.0"?><xliff xmlns="${X}" version="2.0" srcLang="zh-CN" trgLang="en"><file id="f1" original="o.xml">${body}</file></xliff>`;
const report = (xml, meta) => processDelivery(parseXliff(xml), meta);
const byFragment = result => Object.fromEntries(result.entries.map(e => [e.fragment.id, e]));

test('首轮交付分入已接收、待翻译、结构不合法三类', () => {
  const result = report(labels(), { kind: 'first' });
  assert.deepEqual(result.counts, { entries: 4, accepted: 2, pending: 2, invalid: 0 });
  const s1 = byFragment(result).s1;
  assert.equal(s1.outcome, OUTCOME.ACCEPTED);
  assert.equal(s1.reasons[0].code, 'state-reviewed');
  assert.equal(byFragment(result).s2.outcome, OUTCOME.PENDING);
  assert.equal(byFragment(result).s2.reasons[0].code, REASONS.STATE_INITIAL.code);
  assert.equal(byFragment(result).s3.outcome, OUTCOME.PENDING);
  assert.equal(byFragment(result).s3.reasons[0].code, REASONS.TRANSLATE_DISALLOWED.code);

  const broken = report(labels('broken'), { kind: 'broken' });
  assert.equal(broken.counts.invalid, 1);
  assert.equal(byFragment(broken).s1.outcome, OUTCOME.INVALID);
  assert.ok(byFragment(broken).s1.reasons.some(r => r.code === 'target-code-identity-mismatch'));
});

test('未完成译文即使有文字也不能覆盖已审核版本', () => {
  const reviewed = xliff('<unit id="u1"><segment id="s1" state="reviewed"><source>字</source><target>译</target></segment></unit>');
  const draft = xliff('<unit id="u1"><segment id="s1" state="initial"><source>字</source><target>新译</target></segment></unit>');
  const registry = new TranslationRegistry();
  const first = registry.ingest(report(reviewed));
  const second = registry.ingest(report(draft));
  const act = second.actions.find(a => a.current.fragment.id === 's1');
  assert.equal(act.action, ACTION.RETAINED);
  assert.ok(act.reasons.some(r => r.code === 'unfinished-overwrite-blocked'));
  assert.equal(act.current.targetPreview, '译');
  assert.equal(first.actions[0].action, ACTION.RECEIVED);
});

test('带未完成子状态的已写译文同样被挡在待翻译', () => {
  const result = report(labelsFor('substate'));
  const s1 = byFragment(result).s1;
  assert.equal(s1.outcome, OUTCOME.PENDING);
  assert.equal(s1.reasons[0].code, REASONS.SUBSTATE_NOT_FINISHED.code);
  assert.match(s1.reasons[0].detail, /draft/);
  const s2 = byFragment(result).s2;
  assert.equal(s2.outcome, OUTCOME.PENDING);
  assert.match(s2.reasons[0].detail, /mt-suggestion/);
});

test('源文指纹变化阻止自动沿用旧审核结论', () => {
  const first = report(labels('first'));
  const changed = report(labels('changed'));
  const registry = new TranslationRegistry();
  registry.ingest(first);
  const decided = registry.ingest(changed);
  const act = decided.actions.find(a => a.current.fragment.id === 's1');
  assert.equal(act.action, ACTION.BLOCKED);
  assert.ok(act.reasons.some(r => r.code === 'source-fingerprint-changed'));
  // 旧译文仍保留在注册表中，但已标记需要人工确认。
  assert.equal(act.current.blockedPending, true);
});

test('同身份同源文的完成译文执行替换并留存旧版本', () => {
  const registry = new TranslationRegistry();
  registry.ingest(report(labels('first')));
  const decided = registry.ingest(report(labelsFor('second')));
  const s2 = decided.actions.find(a => a.current.fragment.id === 's2');
  assert.equal(s2.action, ACTION.REPLACED);
  assert.equal(s2.current.targetPreview, 'Explanation');
  const stored = registry.snapshot().find(e => e.fragment.id === 's2');
  assert.equal(stored.targetPreview, 'Explanation');
});

test('译文未变则保留而不是重复替换', () => {
  const registry = new TranslationRegistry();
  registry.ingest(report(labels('first')));
  const decided = registry.ingest(report(labelsFor('second')));
  const s1 = decided.actions.find(a => a.current.fragment.id === 's1');
  assert.equal(s1.action, ACTION.RETAINED);
  assert.ok(s1.reasons.some(r => r.code === 'unchanged-target'));
});

test('片段拆分后旧片段消失转人工，新片段独立接收', () => {
  const registry = new TranslationRegistry();
  registry.ingest(report(labels('first')));
  const decided = registry.ingest(report(labelsFor('split')));
  const missing = decided.actions.find(a => a.reasons.some(r => r.code === 'fragment-missing-in-delivery'));
  assert.equal(missing.action, ACTION.BLOCKED);
  assert.equal(missing.current.fragment.id, 's1');
  const fresh = decided.actions.filter(a => ['s1a', 's1b'].includes(a.current.fragment.id));
  assert.deepEqual(fresh.map(a => a.action), [ACTION.RECEIVED, ACTION.RECEIVED]);
});

test('复用unit ID但文件身份不同时各自独立，拒绝混用', () => {
  const registry = new TranslationRegistry();
  const first = registry.ingest(report(labels('first')));
  const decided = registry.ingest(report(labelsFor('reuse')));
  const museumA = decided.registry.filter(e => e.file.id === 'museum-a');
  const museumB = decided.registry.filter(e => e.file.id === 'museum-b');
  assert.equal(museumA.length, first.registry.filter(e => e.file.id === 'museum-a').length);
  assert.equal(museumB.length, 1);
  const act = decided.actions.find(a => a.current.file.id === 'museum-b' && a.current.unit.id === 'u1');
  assert.equal(act.action, ACTION.RECEIVED);
  // 两个 u1 的 entryId 不同，且 museum-a 的既有结论没有被覆盖。
  const idsA = new Set(museumA.map(e => e.entryId));
  const idsB = new Set(museumB.map(e => e.entryId));
  assert.equal([...idsB].some(id => idsA.has(id)), false);
  // museum-a 的既有译文没有被 museum-b 的同名 unit 覆盖，仅因缺席本轮流为人工确认。
  const s1 = museumA.find(e => e.fragment.id === 's1');
  assert.equal(s1.targetPreview, '〔pc#1 开〕Label〔pc#1 合〕');
  assert.equal(s1.blockedPending, true);
});

test('结构不合法交付不覆盖既有译文', () => {
  const registry = new TranslationRegistry();
  registry.ingest(report(labels('first')));
  const decided = registry.ingest(report(labels('broken')));
  const s1 = decided.actions.find(a => a.current.fragment.id === 's1');
  assert.equal(s1.action, ACTION.BLOCKED);
  assert.ok(s1.reasons.some(r => r.code === 'structurally-invalid'));
  assert.equal(s1.current.targetPreview, '〔pc#1 开〕Label〔pc#1 合〕');
});

test('跨片段sc/ec与隔离ph通过后正常接收并保留来源', () => {
  const result = report(labelsFor('cross'));
  assert.equal(result.counts.invalid, 0);
  assert.equal(result.counts.accepted, 3);
  const s5 = byFragment(result).s5;
  assert.equal(s5.target.preview, 'Star〔ph#3〕');
  assert.equal(s5.provenance.originalData.star, '<i>');
  assert.equal(result.namespaceDeclarations.m, 'http://museum.example/ns');
});

test('缺少译文、未知state与translate=no均进待翻译', () => {
  const xml = xliff('<unit id="u1">'
    + '<segment id="a" state="reviewed"><source>甲</source></segment>'
    + '<segment id="b" state="weird"><source>乙</source><target>y</target></segment>'
    + '</unit>'
    + '<unit id="u2" translate="no"><segment id="c" state="final"><source>丙</source><target>z</target></segment></unit>');
  const result = report(xml);
  assert.equal(byFragment(result).a.outcome, OUTCOME.PENDING);
  assert.equal(byFragment(result).a.reasons[0].code, 'target-missing');
  assert.equal(byFragment(result).b.reasons[0].code, 'state-unknown');
  assert.equal(byFragment(result).c.reasons[0].code, 'translate-disallowed');
});

test('注册表可序列化并从磁盘数据恢复', () => {
  const registry = new TranslationRegistry();
  registry.ingest(report(labels('first')));
  const restored = TranslationRegistry.fromJSON(registry.toJSON());
  assert.deepEqual(restored.snapshot().map(e => e.entryId).sort(),
    registry.snapshot().map(e => e.entryId).sort());
  assert.equal(restored.history.length, 1);
});

test('结构不合法后的合法交付可恢复并清除人工标记', () => {
  const registry = new TranslationRegistry();
  registry.ingest(report(labels('first')));
  registry.ingest(report(labels('broken')));
  const healed = registry.ingest(report(labelsFor('second')));
  const s1 = healed.actions.find(a => a.current.fragment.id === 's1');
  assert.equal(s1.action, ACTION.RETAINED);
  const stored = healed.registry.find(e => e.fragment.id === 's1');
  assert.equal(stored.blockedPending, false);
  assert.equal(stored.superseded, false);
});
