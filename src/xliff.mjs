import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

// XLIFF 2.0 命名空间。只有该命名空间内的元素才按 XLIFF 语义解释；
// 其他命名空间（包括带前缀的扩展元素）整体保留为来源，不参与代码配对。
export const XLIFF_NS = 'urn:oasis:names:tc:xliff:document:2.0';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const TEXT = '#text';
const ATTRS = ':@';

const FRAGMENT_NAMES = ['segment', 'ignorable'];
const CONTAINER_NAMES = ['file', 'unit', ...FRAGMENT_NAMES];
const CODE_NAMES = ['pc', 'sc', 'ec', 'ph'];
const CODE_TYPES = new Set(CODE_NAMES);

// 结构不合法原因的机器可读代码，登记人员看到的是 message 中文说明。
export const STRUCTURE_REASONS = {
  CODE_ID_NOT_UNIQUE: 'inline-code-id-not-unique',
  DATA_REF_MISSING: 'inline-code-data-ref-missing',
  CODE_UNBALANCED: 'inline-code-unbalanced',
  TARGET_CODE_MISMATCH: 'target-code-identity-mismatch',
  TARGET_CODE_UNBALANCED: 'target-code-unbalanced',
};

const STRUCTURE_MESSAGES = {
  [STRUCTURE_REASONS.CODE_ID_NOT_UNIQUE]: '内联代码ID在unit内重复',
  [STRUCTURE_REASONS.DATA_REF_MISSING]: '内联代码引用的originalData不存在',
  [STRUCTURE_REASONS.CODE_UNBALANCED]: '源文内联代码无法成对闭合',
  [STRUCTURE_REASONS.TARGET_CODE_MISMATCH]: '译文内联代码身份与源文不一致',
  [STRUCTURE_REASONS.TARGET_CODE_UNBALANCED]: '译文内联代码无法成对闭合',
};

/**
 * 解析 XLIFF 2.0 文档并保留 segment/ignorable 顺序、命名空间与原始引用。
 * 返回 { files, namespaceDeclarations }；结构级错误抛出带“无效”的异常。
 */
export function parseXliff(xml) {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error('翻译文件XML无效');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    // 不能修剪空白：ignorable 片段本身可能只有一个空格。
    trimValues: false,
  });
  const doc = parser.parse(xml);
  const rootEntry = doc.find(entry => entry.xliff);
  if (!rootEntry) throw new Error('缺少xliff根');
  const root = buildElement('xliff', rootEntry.xliff, rootEntry[ATTRS] ?? {}, {});
  if (root.namespace !== XLIFF_NS) throw new Error('xliff根命名空间不是XLIFF2.0');
  if (root.attributes.version !== '2.0') throw new Error('xliff版本不是2.0');

  return {
    srcLang: root.attributes.srcLang ?? null,
    trgLang: root.attributes.trgLang ?? null,
    namespaceDeclarations: collectNamespaceDeclarations(rootEntry[ATTRS] ?? {}),
    files: root.children
      .filter(node => node.kind === 'element' && node.local === 'file' && node.namespace === XLIFF_NS)
      .map(buildFile),
  };
}

function collectNamespaceDeclarations(rawAttrs) {
  return Object.fromEntries(
    Object.entries(rawAttrs)
      .filter(([name]) => name === '@_xmlns' || name.startsWith('@_xmlns:'))
      .map(([name, value]) => [name === '@_xmlns' ? '' : name.slice('@_xmlns:'.length), value]),
  );
}

// 把解析器的 {tag: children, ':@': rawAttrs} 节点转成带命名空间的标准模型。
function buildElement(qName, rawChildren, rawAttrs, parentScope) {
  const scope = { ...parentScope };
  const attrs = {};
  const namespaceDeclarations = {};
  for (const [rawName, value] of Object.entries(rawAttrs)) {
    if (rawName === '@_xmlns') {
      scope[''] = value;
      namespaceDeclarations[''] = value;
      continue;
    }
    if (rawName.startsWith('@_xmlns:')) {
      const prefix = rawName.slice('@_xmlns:'.length);
      scope[prefix] = value;
      namespaceDeclarations[prefix] = value;
      continue;
    }
    const name = rawName.slice(2);
    const colon = name.indexOf(':');
    if (colon >= 0) {
      const prefix = name.slice(0, colon);
      attrs[`{${scope[prefix] ?? ''}}${name.slice(colon + 1)}`] = value;
    } else {
      attrs[name] = value;
    }
  }
  const colon = qName.indexOf(':');
  const prefix = colon >= 0 ? qName.slice(0, colon) : '';
  const local = colon >= 0 ? qName.slice(colon + 1) : qName;
  const namespace = scope[prefix] ?? scope[''] ?? '';

  const children = [];
  for (const entry of rawChildren) {
    if (typeof entry[TEXT] === 'string') {
      children.push({ kind: 'text', text: entry[TEXT] });
      continue;
    }
    const tag = Object.keys(entry).find(name => name !== TEXT && name !== ATTRS);
    if (!tag) continue;
    children.push(buildElement(tag, entry[tag], entry[ATTRS] ?? {}, scope));
  }
  return { kind: 'element', prefix, local, namespace, attributes: attrs, namespaceDeclarations, children };
}

function childElements(node, local) {
  const wanted = new Set(Array.isArray(local) ? local : [local]);
  return node.children.filter(
    child => child.kind === 'element' && child.namespace === XLIFF_NS && wanted.has(child.local),
  );
}

function directChild(node, local) {
  return childElements(node, local)[0] ?? null;
}

// 收集子树内生效的全部命名空间声明（根声明 + 各元素自身声明）。
function collectInScopeNamespaces(node, accumulated = {}) {
  const merged = { ...accumulated, ...(node.namespaceDeclarations ?? {}) };
  let result = { ...merged };
  for (const child of node.children) {
    if (child.kind === 'element') {
      result = { ...result, ...collectInScopeNamespaces(child, merged) };
    }
  }
  return result;
}

function buildFile(fileNode) {
  const notes = collectNotes(fileNode);
  return {
    id: fileNode.attributes.id ?? '',
    original: fileNode.attributes.original ?? null,
    srcLang: fileNode.attributes.srcLang ?? null,
    trgLang: fileNode.attributes.trgLang ?? null,
    translate: normalizeTranslate(fileNode.attributes.translate),
    namespaceDeclarations: collectInScopeNamespaces(fileNode),
    notes,
    units: childElements(fileNode, 'unit').map(buildUnit),
  };
}

function buildUnit(unitNode) {
  const originalData = {};
  const originalDataNode = directChild(unitNode, 'originalData');
  if (originalDataNode) {
    for (const dataNode of childElements(originalDataNode, 'data')) {
      const id = dataNode.attributes.id;
      if (id !== undefined) originalData[id] = serializeText(dataNode.children);
    }
  }
  return {
    id: unitNode.attributes.id ?? '',
    translate: normalizeTranslate(unitNode.attributes.translate),
    notes: collectNotes(unitNode),
    originalData,
    fragments: unitNode.children
      .filter(
        child => child.kind === 'element'
          && child.namespace === XLIFF_NS
          && FRAGMENT_NAMES.includes(child.local),
      )
      .map(buildFragment),
  };
}

function buildFragment(node, ordinal) {
  const sourceNode = directChild(node, 'source');
  const targetNode = directChild(node, 'target');
  return {
    kind: node.local,
    ordinal,
    id: node.attributes.id ?? null,
    state: node.attributes.state ?? null,
    subState: node.attributes.subState ?? null,
    translate: normalizeTranslate(node.attributes.translate),
    sourceNodes: sourceNode ? sourceNode.children : [],
    targetNodes: targetNode ? targetNode.children : [],
    hasTarget: Boolean(targetNode),
  };
}

function collectNotes(containerNode) {
  const notesNode = directChild(containerNode, 'notes');
  if (!notesNode) return [];
  return childElements(notesNode, 'note').map(noteNode => ({
    category: noteNode.attributes.category ?? null,
    id: noteNode.attributes.id ?? null,
    appliesTo: noteNode.attributes.appliesTo ?? null,
    text: serializeText(noteNode.children),
    // 非 XLIFF 命名空间的注释元素整体保留，避免同名元素混用。
    foreign: noteNode.children
      .filter(child => child.kind === 'element' && child.namespace !== XLIFF_NS)
      .map(child => canonical(child)),
  }));
}

function normalizeTranslate(value) {
  if (value === undefined || value === null) return null;
  return value === 'no' ? 'no' : 'yes';
}

function serializeText(nodes) {
  let text = '';
  for (const node of nodes) {
    if (node.kind === 'text') text += node.text;
    else text += serializeText(node.children);
  }
  return text;
}

/**
 * 去掉内联代码后的纯文字，供登记人员查看；代码占位符本身不混入文字，
 * 完整结构始终保留在 sourceXml/sourceFingerprint 中。
 */
export function plainText(nodes) {
  let text = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      text += node.text;
    } else if (node.namespace === XLIFF_NS && CODE_TYPES.has(node.local)) {
      // 代码标记本身剥掉，但代码包住的文字仍是展签文字的一部分。
      text += plainText(node.children);
    } else {
      text += plainText(node.children);
    }
  }
  return text;
}

/** 保留代码位置的可读预览，例如 字〔pc#1 开〕…〔pc#1 合〕，不替代结构化来源。 */
export function previewText(nodes) {
  let text = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      text += node.text;
    } else if (node.namespace === XLIFF_NS && CODE_TYPES.has(node.local)) {
      text += codeLabel(node);
    } else {
      text += previewText(node.children);
    }
  }
  return text;
}

function codeLabel(node) {
  const id = node.attributes.id ?? '?';
  switch (node.local) {
    case 'pc':
      return `〔pc#${id} 开〕${previewText(node.children)}〔pc#${id} 合〕`;
    case 'sc':
      return `〔sc#${id} 开〕`;
    case 'ec':
      return `〔ec#${id} 合〕`;
    case 'ph':
      return `〔ph#${id}〕`;
    default:
      return `〔${node.local}#${id}〕`;
  }
}

// 规范化序列化：命名空间用 Clark 记法，属性按名字排序，保证同构内容指纹稳定。
export function canonical(node) {
  if (node.kind === 'text') return node.text;
  const tag = node.namespace ? `{${node.namespace}}${node.local}` : node.local;
  const attrs = Object.keys(node.attributes)
    .sort()
    .map(name => ` ${name}=${escapeAttribute(node.attributes[name])}`)
    .join('');
  const body = node.children.map(canonical).join('');
  return `<${tag}${attrs}>${body}</${tag}>`;
}

function escapeAttribute(value) {
  return `"${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
}

export function fingerprint(nodes) {
  const canonicalSource = nodes.map(canonical).join('');
  return createHash('sha256').update(canonicalSource).digest('hex');
}

/** 提取片段内全部内联代码（深度优先，即片段顺序）。 */
export function collectCodes(nodes) {
  const codes = [];
  walk(nodes);
  return codes;

  function walk(current) {
    for (const node of current) {
      if (node.kind !== 'element') continue;
      if (node.namespace === XLIFF_NS && CODE_TYPES.has(node.local)) {
        codes.push({
          type: node.local,
          id: node.attributes.id ?? null,
          dataRef: node.attributes.dataRef ?? null,
          dataRefStart: node.attributes.dataRefStart ?? null,
          dataRefEnd: node.attributes.dataRefEnd ?? null,
          startRef: node.attributes.startRef ?? null,
          endRef: node.attributes.endRef ?? null,
        });
      }
      walk(node.children);
    }
  }
}

function reason(code, detail) {
  return { code, message: STRUCTURE_MESSAGES[code], detail };
}

/**
 * 校验一个 unit 的内联代码身份与配对。
 * 返回 Map<片段序号, 原因数组>；空 Map 表示结构合法。
 * 源文与译文中的代码可以成对、隔离(ph)或跨片段(sc/ec)引用。
 */
export function validateUnitCodes(unit) {
  const issues = new Map();
  const addIssue = (ordinal, entry) => {
    if (!issues.has(ordinal)) issues.set(ordinal, []);
    issues.get(ordinal).push(entry);
  };
  const ordinals = new Map();
  const all = [];
  unit.fragments.forEach(fragment => {
    const codes = collectCodes(fragment.sourceNodes);
    for (const code of codes) ordinals.set(code.id, fragment.ordinal);
    all.push(...codes);
  });

  // 1. 代码 ID 在 unit 内必须唯一。
  const seen = new Set();
  for (const code of all) {
    if (code.id === null || seen.has(code.id)) {
      addIssue(ordinals.get(code.id) ?? 0, reason(STRUCTURE_REASONS.CODE_ID_NOT_UNIQUE, `代码 ${code.type}#${code.id}`));
    }
    seen.add(code.id);
  }

  // 2. 原始数据引用必须能在 unit 的 originalData 中解析。
  for (const code of all) {
    const refs = code.type === 'pc'
      ? [code.dataRefStart, code.dataRefEnd]
      : [code.dataRef];
    for (const ref of refs) {
      if (ref !== null && !(ref in unit.originalData)) {
        addIssue(ordinals.get(code.id), reason(STRUCTURE_REASONS.DATA_REF_MISSING, `${code.type}#${code.id} 引用 ${ref}`));
      }
    }
  }

  // 3. 源文配对：pc 自身成对；sc/ec 按 startRef/endRef 跨片段闭合；ph 独立。
  const sourceById = new Map(all.map(code => [code.id, code]));
  const openSc = new Map();
  unit.fragments.forEach(fragment => {
    for (const code of collectCodes(fragment.sourceNodes)) {
      if (code.type === 'pc') continue;
      if (code.type === 'sc') openSc.set(code.id, code);
      if (code.type === 'ec') {
        const startId = code.startRef;
        const start = openSc.get(startId) ?? sourceById.get(startId);
        if (!start || start.type !== 'sc') {
          addIssue(fragment.ordinal, reason(STRUCTURE_REASONS.CODE_UNBALANCED, `ec#${code.id} 找不到起始 sc#${startId ?? ''}`));
        } else {
          openSc.delete(startId);
        }
      }
    }
  });
  for (const code of openSc.values()) {
    addIssue(ordinals.get(code.id), reason(STRUCTURE_REASONS.CODE_UNBALANCED, `sc#${code.id} 没有闭合 ec`));
  }
  for (const code of all) {
    if (code.type === 'ec' && code.startRef !== null && !sourceById.has(code.startRef)) {
      addIssue(ordinals.get(code.id), reason(STRUCTURE_REASONS.CODE_UNBALANCED, `ec#${code.id} 的 startRef=${code.startRef} 不存在`));
    }
  }

  // 4. 逐片段校验译文代码身份；sc/ec 配对在 unit 范围内跨片段进行。
  const targetOpen = new Map();
  const targetById = new Map();
  const targetOrdinal = new Map();
  unit.fragments.forEach(fragment => {
    const sourceCodes = collectCodes(fragment.sourceNodes);
    const targetCodes = collectCodes(fragment.targetNodes);
    const sourceKey = new Map(sourceCodes.map(code => [code.id, code]));
    const targetKey = new Map(targetCodes.map(code => [code.id, code]));
    for (const code of targetCodes) {
      targetById.set(code.id, code);
      targetOrdinal.set(code.id, fragment.ordinal);
    }

    for (const code of targetCodes) {
      const counterpart = sourceKey.get(code.id);
      if (!counterpart) {
        addIssue(fragment.ordinal, reason(STRUCTURE_REASONS.TARGET_CODE_MISMATCH, `译文多出代码 ${code.type}#${code.id}`));
        continue;
      }
      if (counterpart.type !== code.type) {
        addIssue(fragment.ordinal, reason(STRUCTURE_REASONS.TARGET_CODE_MISMATCH, `代码 #${code.id} 类型由 ${counterpart.type} 变为 ${code.type}`));
      }
      const refs = code.type === 'pc'
        ? [['dataRefStart', code.dataRefStart, counterpart.dataRefStart], ['dataRefEnd', code.dataRefEnd, counterpart.dataRefEnd]]
        : [['dataRef', code.dataRef, counterpart.dataRef]];
      for (const [attr, actual, expected] of refs) {
        if (actual !== expected) {
          addIssue(fragment.ordinal, reason(STRUCTURE_REASONS.TARGET_CODE_MISMATCH, `代码 #${code.id} 的 ${attr} 由 ${expected} 变为 ${actual}`));
        }
      }
      if (actualRefMissing(code, unit.originalData)) {
        addIssue(fragment.ordinal, reason(STRUCTURE_REASONS.DATA_REF_MISSING, `译文 ${code.type}#${code.id} 引用无法解析`));
      }
    }
    for (const code of sourceCodes) {
      if (!targetKey.has(code.id)) {
        addIssue(fragment.ordinal, reason(STRUCTURE_REASONS.TARGET_CODE_MISMATCH, `译文缺少代码 ${code.type}#${code.id}`));
      }
    }
  });

  // 译文 sc/ec 按文档顺序跨片段闭合；未闭合与悬空引用都记到所在片段。
  unit.fragments.forEach(fragment => {
    for (const code of collectCodes(fragment.targetNodes)) {
      if (code.type === 'sc') targetOpen.set(code.id, code);
      if (code.type === 'ec') {
        const startId = code.startRef;
        const start = targetOpen.get(startId) ?? targetById.get(startId);
        if (!start || start.type !== 'sc') {
          addIssue(fragment.ordinal, reason(STRUCTURE_REASONS.TARGET_CODE_UNBALANCED, `译文 ec#${code.id} 找不到起始 sc#${startId ?? ''}`));
        } else {
          targetOpen.delete(startId);
        }
      }
    }
  });
  for (const code of targetOpen.values()) {
    addIssue(targetOrdinal.get(code.id),
      reason(STRUCTURE_REASONS.TARGET_CODE_UNBALANCED, `译文 sc#${code.id} 没有闭合 ec`));
  }

  return issues;
}

function actualRefMissing(code, originalData) {
  const refs = code.type === 'pc' ? [code.dataRefStart, code.dataRefEnd] : [code.dataRef];
  return refs.some(ref => ref !== null && !(ref in originalData));
}

/** 沿 file -> unit -> fragment 解析 translate="no" 的继承语义。 */
export function effectiveTranslate(file, unit, fragment) {
  for (const value of [fragment.translate, unit.translate, file.translate]) {
    if (value !== null) return value;
  }
  return 'yes';
}
