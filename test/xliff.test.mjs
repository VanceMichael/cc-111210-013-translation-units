import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonical,
  collectCodes,
  fingerprint,
  parseXliff,
  plainText,
  previewText,
  validateUnitCodes,
  XLIFF_NS,
} from '../src/xliff.mjs';
import { labels, labelsFor } from '../fixtures/source.mjs';

test('解析保留segment与ignorable的文档顺序和身份', () => {
  const doc = parseXliff(labels());
  assert.equal(doc.srcLang, 'zh-CN');
  assert.equal(doc.trgLang, 'en');
  const unit = doc.files[0].units[0];
  assert.deepEqual(unit.fragments.map(f => `${f.kind}:${f.id}`), ['segment:s1', 'ignorable:space', 'segment:s2']);
  assert.deepEqual(unit.fragments.map(f => f.ordinal), [0, 1, 2]);
  assert.throws(() => parseXliff('<xliff><bad></xliff>'), /无效/);
  assert.throws(() => parseXliff('<xliff xmlns="wrong:ns" version="2.0"/>'), /命名空间/);
});

test('纯文字剥离内联代码但完整结构保留在canonical XML中', () => {
  const doc = parseXliff(labels());
  const source = doc.files[0].units[0].fragments[0].sourceNodes;
  assert.equal(plainText(source), '展签');
  assert.match(previewText(source), /〔pc#1 开〕展签〔pc#1 合〕/);
  assert.match(source.map(canonical).join(''), /\{urn:oasis:names:tc:xliff:document:2.0\}pc/);
  // 同构内容指纹稳定，空白差异不影响。
  const again = parseXliff(labels()).files[0].units[0].fragments[0].sourceNodes;
  assert.equal(fingerprint(source), fingerprint(again));
});

test('ignorable的纯空白文本不被修剪', () => {
  const doc = parseXliff(labels());
  const ignorable = doc.files[0].units[0].fragments[1];
  assert.equal(plainText(ignorable.sourceNodes), ' ');
  assert.equal(plainText(ignorable.targetNodes), ' ');
});

test('originalData与notes原样保留为来源', () => {
  const doc = parseXliff(labels());
  const unit = doc.files[0].units[0];
  assert.equal(unit.originalData.open, '<b>');
  assert.equal(unit.originalData.close, '</b>');
  assert.equal(unit.notes[0].category, 'description');
  assert.equal(unit.notes[0].text, '主展签');
});

test('pc成对、ph隔离、sc/ec跨片段引用均通过校验', () => {
  const doc = parseXliff(labelsFor('cross'));
  const unit = doc.files[0].units[0];
  const issues = validateUnitCodes(unit);
  assert.deepEqual([...issues.keys()], []);
  const codes = unit.fragments.flatMap(f => collectCodes(f.sourceNodes));
  assert.deepEqual(codes.map(c => `${c.type}#${c.id}`), ['sc#1', 'ec#2', 'ph#3']);
  // 扩展命名空间元素不被当成 XLIFF 内联代码。
  assert.equal(collectCodes(unit.fragments[0].sourceNodes).length, 1);
});

test('译文代码ID与源文不符判为结构不合法并指出差异', () => {
  const doc = parseXliff(labels('broken'));
  const issues = validateUnitCodes(doc.files[0].units[0]);
  const reasons = issues.get(0).map(r => r.code);
  assert.ok(reasons.includes('target-code-identity-mismatch'));
  const detail = issues.get(0).map(r => r.detail).join(' ');
  assert.match(detail, /pc#2/);
  assert.match(detail, /pc#1/);
});

test('sc缺少闭合ec、dataRef无法解析均报错', () => {
  const xml = `<xliff xmlns="${XLIFF_NS}" version="2.0"><file id="f1"><unit id="u1">
    <originalData><data id="o">&lt;b&gt;</data></originalData>
    <segment id="s1" state="final"><source><sc id="1" dataRef="o"/>字</source><target><sc id="1" dataRef="o"/>x</target></segment>
    <segment id="s2" state="final"><source><ph id="9" dataRef="missing"/></source><target><ph id="9" dataRef="missing"/></target></segment>
  </unit></file></xliff>`;
  const doc = parseXliff(xml);
  const issues = validateUnitCodes(doc.files[0].units[0]);
  const all = [...issues.values()].flat().map(r => r.code);
  assert.ok(all.includes('inline-code-unbalanced'));
  assert.ok(all.includes('inline-code-data-ref-missing'));
});

test('译文内联代码类型或dataRef变化同样阻止接收', () => {
  const xml = `<xliff xmlns="${XLIFF_NS}" version="2.0"><file id="f1"><unit id="u1">
    <originalData><data id="o">&lt;b&gt;</data><data id="c">&lt;/b&gt;</data></originalData>
    <segment id="s1" state="reviewed">
      <source><pc id="1" dataRefStart="o" dataRefEnd="c">字</pc></source>
      <target><ph id="1" dataRef="o"/></target>
    </segment>
  </unit></file></xliff>`;
  const doc = parseXliff(xml);
  const issues = validateUnitCodes(doc.files[0].units[0]);
  assert.ok(issues.get(0).some(r => r.detail.includes('类型由 pc 变为 ph')));
});

test('带前缀的扩展命名空间元素整体保留且不与同名XLIFF元素混用', () => {
  const doc = parseXliff(labelsFor('cross'));
  const source = doc.files[0].units[0].fragments[0].sourceNodes;
  const foreign = source.find(n => n.kind === 'element' && n.local === 'note' && n.namespace === 'http://museum.example/ns');
  assert.ok(foreign);
  assert.equal(foreign.namespace, 'http://museum.example/ns');
  assert.equal(plainText(source).includes('馆藏专用'), true);
});
