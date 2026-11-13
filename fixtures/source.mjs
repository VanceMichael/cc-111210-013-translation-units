import { listen } from '../src/http.mjs';

const HEADER = '<?xml version="1.0"?><xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="zh-CN" trgLang="en">';
const FOOTER = '</xliff>';

// 既有三种交付保持字节级不变，避免影响既有协议与测试。
export function labels(kind = 'first') {
  const source = kind === 'changed' ? '新版展签' : '展签';
  const target = kind === 'broken'
    ? '<pc id="1" dataRefStart="open" dataRefEnd="close">Label</pc>'
    : '<pc id="1" dataRefStart="open" dataRefEnd="close">Label</pc>';
  if (kind === 'broken') {
    return `${HEADER}<file id="museum-a" original="labels.xml"><unit id="u1"><notes><note category="description">主展签</note></notes><originalData><data id="open">&lt;b&gt;</data><data id="close">&lt;/b&gt;</data></originalData><segment id="s1" state="reviewed"><source><pc id="1" dataRefStart="open" dataRefEnd="close">${source}</pc></source><target><pc id="2" dataRefStart="open" dataRefEnd="close">Label</pc></target></segment><ignorable id="space"><source> </source><target> </target></ignorable><segment id="s2" state="initial"><source>说明</source><target>Draft</target></segment></unit><unit id="u2" translate="no"><segment id="s3" state="final"><source>IP标志</source><target>IP</target></segment></unit></file></xliff>`;
  }
  return `${HEADER}<file id="museum-a" original="labels.xml"><unit id="u1"><notes><note category="description">主展签</note></notes><originalData><data id="open">&lt;b&gt;</data><data id="close">&lt;/b&gt;</data></originalData><segment id="s1" state="reviewed"><source><pc id="1" dataRefStart="open" dataRefEnd="close">${source}</pc></source><target>${target}</target></segment><ignorable id="space"><source> </source><target> </target></ignorable><segment id="s2" state="initial"><source>说明</source><target>Draft</target></segment></unit><unit id="u2" translate="no"><segment id="s3" state="final"><source>IP标志</source><target>IP</target></segment></unit></file></xliff>`;
}

const NOTES = '<notes><note category="description">主展签</note></notes>';
const ORIGINAL = '<originalData><data id="open">&lt;b&gt;</data><data id="close">&lt;/b&gt;</data><data id="star">&lt;i&gt;</data></originalData>';

const BUILDERS = {
  // 二次交付：s1 译文未变（保留）、s2 完成翻译（替换）、新增 s4（首次接收）。
  second() {
    return `${HEADER}<file id="museum-a" original="labels.xml"><unit id="u1">${NOTES}${ORIGINAL}`
      + '<segment id="s1" state="reviewed"><source><pc id="1" dataRefStart="open" dataRefEnd="close">展签</pc></source><target><pc id="1" dataRefStart="open" dataRefEnd="close">Label</pc></target></segment>'
      + '<ignorable id="space"><source> </source><target> </target></ignorable>'
      + '<segment id="s2" state="reviewed"><source>说明</source><target>Explanation</target></segment>'
      + '<segment id="s4" state="final"><source>新展品</source><target>New Exhibit</target></segment>'
      + `</unit><unit id="u2" translate="no"><segment id="s3" state="final"><source>IP标志</source><target>IP</target></segment></unit></file>${FOOTER}`;
  },
  // 拆分片段：原 s1 源文被拆成两段，新片段是新身份；旧片段在本次交付消失，转人工。
  split() {
    return `${HEADER}<file id="museum-a" original="labels.xml"><unit id="u1">${NOTES}${ORIGINAL}`
      + '<segment id="s1a" state="reviewed"><source><pc id="1" dataRefStart="open" dataRefEnd="close">展</pc></source><target><pc id="1" dataRefStart="open" dataRefEnd="close">Exhibit</pc></target></segment>'
      + '<segment id="s1b" state="translated"><source>签</source><target>Label</target></segment>'
      + '<ignorable id="space"><source> </source><target> </target></ignorable>'
      + '<segment id="s2" state="reviewed"><source>说明</source><target>Explanation</target></segment>'
      + `</unit></file>${FOOTER}`;
  },
  // 复用 unit ID：两个文件各有 u1，但文件身份与命名空间不同，禁止混用。
  reuse() {
    return `${HEADER}<file id="museum-b" original="other-labels.xml"><unit id="u1">`
      + '<segment id="s1" state="final"><source>展签</source><target>Sign</target></segment>'
      + `</unit></file>${FOOTER}`;
  },
  // 跨片段的 sc/ec 配对，且带扩展命名空间元素，代码身份必须在源/译文间一致。
  cross() {
    return `${HEADER}<file id="museum-a" original="labels.xml" xmlns:m="http://museum.example/ns"><unit id="u1">${NOTES}${ORIGINAL}`
      + '<segment id="s1" state="reviewed"><source><sc id="1" dataRef="open"/><m:note>馆藏专用</m:note>展签</source><target><sc id="1" dataRef="open"/>Label</target></segment>'
      + '<segment id="s2" state="final"><source>说明<ec id="2" startRef="1" dataRef="close"/></source><target>Explanation<ec id="2" startRef="1" dataRef="close"/></target></segment>'
      + '<segment id="s5" state="translated"><source>星标<ph id="3" dataRef="star"/></source><target>Star<ph id="3" dataRef="star"/></target></segment>'
      + `</unit></file>${FOOTER}`;
  },
  // 已写文字但子状态仍是草稿：未完成译文不得覆盖已审核版本。
  substate() {
    return `${HEADER}<file id="museum-a" original="labels.xml"><unit id="u1">${NOTES}${ORIGINAL}`
      + '<segment id="s1" state="reviewed" subState="urn:museum:substate:draft"><source><pc id="1" dataRefStart="open" dataRefEnd="close">展签</pc></source><target><pc id="1" dataRefStart="open" dataRefEnd="close">New Label</pc></target></segment>'
      + '<ignorable id="space"><source> </source><target> </target></ignorable>'
      + '<segment id="s2" state="translated" subState="urn:museum:substate:mt-suggestion"><source>说明</source><target>Explanation Draft</target></segment>'
      + `</unit></file>${FOOTER}`;
  },
};

export function labelsFor(kind) {
  return BUILDERS[kind] ? BUILDERS[kind]() : labels(kind);
}

export async function startFixture() {
  return listen(async url => url.pathname === '/labels.xlf'
    ? { type: 'application/xliff+xml', body: labelsFor(url.searchParams.get('kind') ?? 'first') }
    : { status: 404, body: {} });
}
