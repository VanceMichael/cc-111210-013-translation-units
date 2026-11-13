import { createHash } from 'node:crypto';
import {
  canonical,
  effectiveTranslate,
  fingerprint,
  plainText,
  previewText,
  validateUnitCodes,
} from './xliff.mjs';

// 秘书处看到的三类结果。
export const OUTCOME = {
  ACCEPTED: 'accepted', // 已接收：译文可用且通过结构与状态闸门
  PENDING: 'pending',   // 待翻译：结构合法但译文缺失或尚未完成
  INVALID: 'invalid',   // 结构不合法：内联代码身份/配对等校验未过
};

// 二次交付时每条译文的处置。
export const ACTION = {
  RECEIVED: 'received', // 首次接收
  RETAINED: 'retained', // 保留既有已接收译文
  REPLACED: 'replaced', // 以新译文替换
  BLOCKED: 'blocked',   // 阻止自动处理，留待人工确认
};

// 原因代码集中管理，message 面向登记人员，code 供系统判定与回归测试。
export const REASONS = {
  TRANSLATE_DISALLOWED: { code: 'translate-disallowed', message: '单元或文件标记 translate=no，不接收译文' },
  TARGET_MISSING: { code: 'target-missing', message: '片段缺少译文，等待翻译' },
  STATE_MISSING: { code: 'state-missing', message: '片段缺少 state，按未完成处理' },
  STATE_INITIAL: { code: 'state-initial', message: 'state=initial，译文尚未完成' },
  STATE_UNKNOWN: { code: 'state-unknown', message: 'state 不在 XLIFF 2.0 取值内，按未完成处理' },
  SUBSTATE_NOT_FINISHED: { code: 'substate-not-finished', message: '子状态标记译文未完成，不能覆盖已审核版本' },
  IGNORABLE_CARRIED: { code: 'ignorable-carried', message: 'ignorable 片段随结构保留，不作为展签译文录入' },
  ACCEPTED_TRANSLATED: { code: 'state-translated', message: 'state=translated，译文已完成' },
  ACCEPTED_REVIEWED: { code: 'state-reviewed', message: 'state=reviewed，译文已审核' },
  ACCEPTED_FINAL: { code: 'state-final', message: 'state=final，译文已定稿' },
};

const FINISHED_STATES = new Set(['translated', 'reviewed', 'final']);
const UNFINISHED_SUBSTATE = new Set([
  'initial', 'draft', 'new', 'unfinished', 'tentative',
  'in-progress', 'inprogress', 'mt', 'mt-suggestion', 'machine-translated',
]);

// 子状态允许厂商前缀（URN 或冒号命名空间），只看本地取值。
function isUnfinishedSubState(subState) {
  const local = subState.slice(subState.lastIndexOf(':') + 1).toLowerCase();
  if (UNFINISHED_SUBSTATE.has(local)) return true;
  return local.startsWith('draft') || local.startsWith('needs-')
    || local.startsWith('unfinished') || local.startsWith('mt-') || local.startsWith('in-progress');
}

function reason(entry, detail) {
  return { code: entry.code, message: entry.message, ...(detail ? { detail } : {}) };
}

// 身份四要素中的“文件身份”包含 file id、original 与文件级命名空间集合，
// 同名 unit 出现在不同文件/命名空间时得到不同 entryId，不会混用。
export function entryId(file, unit, fragment, namespaceDeclarations = {}) {
  const raw = [
    file.id,
    file.original ?? '',
    JSON.stringify(namespaceDeclarations),
    unit.id,
    `${fragment.kind}:${fragment.id ?? '#' + fragment.ordinal}`,
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function textView(nodes) {
  if (nodes.length === 0) return null;
  return {
    plainText: plainText(nodes),       // 去代码后的纯文字，不与占位符混合
    preview: previewText(nodes),       // 保留代码位置的预览
    xml: nodes.map(canonical).join(''), // 完整结构来源
    fingerprint: fingerprint(nodes),   // 源文/译文指纹
  };
}

function evaluateState(fragment) {
  const state = fragment.state;
  if (state === null) return { finished: false, reason: reason(REASONS.STATE_MISSING) };
  if (state === 'initial') return { finished: false, reason: reason(REASONS.STATE_INITIAL) };
  if (!FINISHED_STATES.has(state)) {
    return { finished: false, reason: reason(REASONS.STATE_UNKNOWN, `state=${state}`) };
  }
  if (fragment.subState && isUnfinishedSubState(fragment.subState)) {
    return { finished: false, reason: reason(REASONS.SUBSTATE_NOT_FINISHED, `subState=${fragment.subState}`) };
  }
  const acceptedReason = {
    translated: REASONS.ACCEPTED_TRANSLATED,
    reviewed: REASONS.ACCEPTED_REVIEWED,
    final: REASONS.ACCEPTED_FINAL,
  }[state];
  return { finished: true, reason: reason(acceptedReason) };
}

function buildEntry(file, unit, fragment, structureReasons) {
  const source = textView(fragment.sourceNodes);
  const target = fragment.hasTarget ? textView(fragment.targetNodes) : null;
  const entry = {
    entryId: entryId(file, unit, fragment, file.namespaceDeclarations),
    file: { id: file.id, original: file.original, srcLang: file.srcLang ?? null, trgLang: file.trgLang ?? null },
    unit: { id: unit.id, translate: unit.translate ?? 'inherit' },
    fragment: {
      id: fragment.id,
      kind: fragment.kind,
      ordinal: fragment.ordinal,
      state: fragment.state,
      subState: fragment.subState,
    },
    source,
    target,
    outcome: null,
    reasons: [],
    // 来源留存：notes 与 originalData 原样保留，命名空间在报告级与 canonical XML 中保留。
    provenance: {
      notes: unit.notes,
      originalData: unit.originalData,
    },
  };

  if (structureReasons.length > 0) {
    entry.outcome = OUTCOME.INVALID;
    entry.reasons = structureReasons;
    return entry;
  }

  if (effectiveTranslate(file, unit, fragment) === 'no') {
    entry.outcome = OUTCOME.PENDING;
    entry.reasons = [reason(REASONS.TRANSLATE_DISALLOWED)];
    return entry;
  }

  if (fragment.kind === 'ignorable') {
    if (!fragment.hasTarget) {
      entry.outcome = OUTCOME.PENDING;
      entry.reasons = [reason(REASONS.TARGET_MISSING, 'ignorable 片段无译文')];
    } else {
      entry.outcome = OUTCOME.ACCEPTED;
      entry.reasons = [reason(REASONS.IGNORABLE_CARRIED)];
    }
    return entry;
  }

  if (!fragment.hasTarget) {
    entry.outcome = OUTCOME.PENDING;
    entry.reasons = [reason(REASONS.TARGET_MISSING)];
    return entry;
  }

  const gate = evaluateState(fragment);
  entry.outcome = gate.finished ? OUTCOME.ACCEPTED : OUTCOME.PENDING;
  entry.reasons = [gate.reason];
  return entry;
}

/**
 * 处理一次交付：逐 unit 校验内联代码，再按状态/子状态/可翻译性决定片段去向。
 * 片段顺序与文档一致；结果分为已接收、待翻译、结构不合法三类。
 */
export function processDelivery(doc, meta = {}) {
  const buckets = {
    [OUTCOME.ACCEPTED]: [],
    [OUTCOME.PENDING]: [],
    [OUTCOME.INVALID]: [],
  };
  const entries = [];

  for (const file of doc.files) {
    for (const unit of file.units) {
      const issueMap = validateUnitCodes(unit);
      for (const fragment of unit.fragments) {
        const entry = buildEntry(file, unit, fragment, issueMap.get(fragment.ordinal) ?? []);
        entries.push(entry);
        buckets[entry.outcome].push(entry);
      }
    }
  }

  return {
    delivery: {
      kind: meta.kind ?? null,
      label: meta.label ?? null,
      receivedAt: new Date().toISOString(),
    },
    srcLang: doc.srcLang,
    trgLang: doc.trgLang,
    namespaceDeclarations: Object.fromEntries(doc.files.flatMap(file =>
      Object.entries(file.namespaceDeclarations ?? {})).sort()),
    files: doc.files.map(file => ({ id: file.id, namespaceDeclarations: file.namespaceDeclarations })),
    counts: {
      entries: entries.length,
      accepted: buckets[OUTCOME.ACCEPTED].length,
      pending: buckets[OUTCOME.PENDING].length,
      invalid: buckets[OUTCOME.INVALID].length,
    },
    buckets,
    entries,
  };
}
