import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ACTION, OUTCOME, REASONS } from './reception.mjs';

// 跨交付冲突原因：任何冲突都只记录并等待人工确认，不自动沿用旧审核结论。
const CONFLICT_REASONS = {
  SOURCE_CHANGED: { code: 'source-fingerprint-changed', message: '同一片段的源文指纹已变化，旧审核结论不可沿用' },
  MISSING_IN_DELIVERY: { code: 'fragment-missing-in-delivery', message: '后续交付缺少该片段，保留旧译文并标记人工确认' },
  PENDING_OVERWRITES_ACCEPTED: { code: 'unfinished-overwrite-blocked', message: '未完成译文不能覆盖已审核版本' },
  INVALID_DELIVERY: { code: 'structurally-invalid', message: '结构不合法的译文不能录入，旧译文保持不变' },
  TRANSLATE_DISALLOWED: { code: 'translate-disallowed', message: '后续交付将片段标记为不可翻译，需人工确认' },
  IDENTITY_CONFLICT: { code: 'identity-conflict', message: 'unit ID 被复用但文件身份或命名空间不一致' },
};

function explain(code, detail) {
  const entry = CONFLICT_REASONS[code];
  return { code: entry.code, message: entry.message, ...(detail ? { detail } : {}) };
}

function currentKey(entry) {
  return [entry.file.id, entry.unit.id, entry.fragment.kind, entry.fragment.id ?? `#${entry.fragment.ordinal}`].join('|');
}

/**
 * 登记已接收译文并跨交付裁决。
 * 身份四要素：文件身份、unit、片段（id/序号与 segment/ignorable 种类）、源文指纹。
 */
export class TranslationRegistry {
  #entries = new Map(); // entryId -> 当前条目快照
  #history = [];        // 每次交付的逐条裁决，供秘书处追溯

  ingest(report) {
    const seen = new Set();
    const actions = [];

    for (const incoming of report.entries) {
      seen.add(incoming.entryId);
      const previous = this.#entries.get(incoming.entryId);
      const action = this.#decide(previous, incoming, report);
      // 恢复正常的路径必须清除上一轮遗留的人工确认标记，避免状态残留。
      if (action.action !== ACTION.BLOCKED) {
        const current = this.#entries.get(incoming.entryId);
        this.#entries.set(incoming.entryId, { ...current, blockedPending: false, superseded: false });
      }
      actions.push({
        entryId: incoming.entryId,
        action: action.action,
        reasons: action.reasons,
        current: this.#snapshot(incoming.entryId),
        incoming: summarize(incoming),
      });
    }

    // 本次交付中消失的旧片段（可能被拆分或删除）：不删除、不沿用结论，转人工。
    for (const [entryId, previous] of this.#entries) {
      if (seen.has(entryId)) continue;
      const blocked = {
        ...previous,
        outcome: OUTCOME.PENDING,
        reasons: [explain('MISSING_IN_DELIVERY', currentKey(previous))],
        superseded: true,
        blockedPending: true,
      };
      this.#entries.set(entryId, blocked);
      actions.push({
        entryId,
        action: ACTION.BLOCKED,
        reasons: blocked.reasons,
        current: this.#snapshot(entryId),
        incoming: null,
      });
    }

    const record = {
      delivery: report.delivery,
      counts: report.counts,
      actions,
      actionSummary: summarizeActions(actions),
    };
    this.#history.push(record);
    return { ...report, actions, actionSummary: record.actionSummary, registry: this.snapshot() };
  }

  #decide(previous, incoming, report) {
    if (!previous) {
      if (incoming.outcome === OUTCOME.ACCEPTED) {
        this.#entries.set(incoming.entryId, { ...incoming });
        return { action: ACTION.RECEIVED, reasons: incoming.reasons };
      }
      // 首次即为待翻译或不合法：登记占位条目，便于后续交付继续跟踪。
      this.#entries.set(incoming.entryId, { ...incoming });
      return {
        action: ACTION.BLOCKED,
        reasons: incoming.outcome === OUTCOME.INVALID
          ? [explain('INVALID_DELIVERY'), ...incoming.reasons]
          : incoming.reasons,
      };
    }

    // 文件身份核对：同名 unit 若来自不同文件或原始引用，拒绝混用。
    if (previous.file.id !== incoming.file.id || previous.file.original !== incoming.file.original) {
      this.#markBlocked(incoming, explain('IDENTITY_CONFLICT',
        `既有 ${previous.file.id}/${previous.file.original}，交付 ${incoming.file.id}/${incoming.file.original}`));
      return { action: ACTION.BLOCKED, reasons: this.#entries.get(incoming.entryId).reasons };
    }

    // 源文指纹是替换闸门：源文变了，旧译文与旧审核结论都不能自动沿用。
    if (previous.source && incoming.source && previous.source.fingerprint !== incoming.source.fingerprint) {
      this.#markBlocked(incoming, explain('SOURCE_CHANGED',
        `${previous.source.fingerprint.slice(0, 12)} -> ${incoming.source.fingerprint.slice(0, 12)}`));
      return { action: ACTION.BLOCKED, reasons: this.#entries.get(incoming.entryId).reasons };
    }

    if (incoming.outcome === OUTCOME.INVALID) {
      this.#markBlocked(incoming, explain('INVALID_DELIVERY'));
      return { action: ACTION.BLOCKED, reasons: this.#entries.get(incoming.entryId).reasons };
    }

    if (incoming.reasons.some(r => r.code === REASONS.TRANSLATE_DISALLOWED.code)) {
      this.#markBlocked(incoming, explain('TRANSLATE_DISALLOWED'));
      return { action: ACTION.BLOCKED, reasons: this.#entries.get(incoming.entryId).reasons };
    }

    if (incoming.outcome === OUTCOME.PENDING) {
      if (previous.outcome === OUTCOME.ACCEPTED) {
        // 未完成译文不能因为有文字就覆盖已审核版本：旧译文原样保留。
        const retained = {
          ...previous,
          reasons: [explain('PENDING_OVERWRITES_ACCEPTED'), ...incoming.reasons],
        };
        this.#entries.set(incoming.entryId, retained);
        return { action: ACTION.RETAINED, reasons: retained.reasons };
      }
      this.#entries.set(incoming.entryId, { ...incoming });
      return { action: ACTION.BLOCKED, reasons: incoming.reasons };
    }

    // incoming 为已接收。
    if (previous.outcome === OUTCOME.ACCEPTED
      && previous.target && incoming.target
      && previous.target.fingerprint === incoming.target.fingerprint) {
      this.#entries.set(incoming.entryId, { ...incoming });
      return {
        action: ACTION.RETAINED,
        reasons: [
          { code: 'unchanged-target', message: '译文指纹与已接收版本一致，原样保留' },
          ...incoming.reasons,
        ],
      };
    }

    // 四要素一致且新译文完成：替换，并把旧版本留在 provenance 中可追溯。
    const replaced = {
      ...incoming,
      provenance: {
        ...incoming.provenance,
        previousAccepted: previous.outcome === OUTCOME.ACCEPTED
          ? { target: previous.target, fragment: previous.fragment, supersededAt: report.delivery.receivedAt }
          : null,
      },
    };
    this.#entries.set(incoming.entryId, replaced);
    return {
      action: ACTION.REPLACED,
      reasons: [{ code: 'target-updated', message: '源文指纹一致且新译文已完成，替换旧版本' }, ...incoming.reasons],
    };
  }

  #markBlocked(incoming, conflictReason) {
    const previous = this.#entries.get(incoming.entryId);
    this.#entries.set(incoming.entryId, {
      ...(previous ?? incoming),
      outcome: previous?.outcome === OUTCOME.ACCEPTED ? OUTCOME.ACCEPTED : OUTCOME.PENDING,
      reasons: [conflictReason, ...incoming.reasons],
      blockedPending: true,
      lastDelivery: incoming.delivery,
    });
  }

  #snapshot(entryId) {
    const entry = this.#entries.get(entryId);
    return entry ? summarize(entry) : null;
  }

  snapshot() {
    return [...this.#entries.values()].map(summarize);
  }

  get history() {
    return this.#history;
  }

  toJSON() {
    return { entries: [...this.#entries.values()], history: this.#history };
  }

  static fromJSON(data) {
    const registry = new TranslationRegistry();
    for (const entry of data.entries ?? []) registry.#entries.set(entry.entryId, entry);
    registry.#history = data.history ?? [];
    return registry;
  }
}

function summarize(entry) {
  return {
    entryId: entry.entryId,
    outcome: entry.outcome,
    reasons: entry.reasons,
    file: entry.file,
    unit: entry.unit,
    fragment: entry.fragment,
    sourceFingerprint: entry.source?.fingerprint ?? null,
    targetFingerprint: entry.target?.fingerprint ?? null,
    targetPreview: entry.target?.preview ?? null,
    sourcePreview: entry.source?.preview ?? null,
    blockedPending: entry.blockedPending ?? false,
    superseded: entry.superseded ?? false,
  };
}

function summarizeActions(actions) {
  const summary = { [ACTION.RECEIVED]: 0, [ACTION.RETAINED]: 0, [ACTION.REPLACED]: 0, [ACTION.BLOCKED]: 0 };
  for (const action of actions) summary[action.action] += 1;
  return summary;
}

// 注册表持久化：原子写、读回校验，防止磁盘损坏后静默沿用旧结论。
export class RegistryStore {
  constructor(directory) { this.directory = directory; }
  get path() { return join(this.directory, 'registry.json'); }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const wrapper = JSON.parse(raw);
      if (digest(JSON.stringify(wrapper.data)) !== wrapper.digest) throw new Error('注册表校验失败');
      return TranslationRegistry.fromJSON(wrapper.data);
    } catch (error) {
      if (error.code === 'ENOENT') return new TranslationRegistry();
      throw error;
    }
  }

  async save(registry) {
    await mkdir(this.directory, { recursive: true });
    const data = registry.toJSON();
    const wrapper = { digest: digest(JSON.stringify(data)), data };
    const temporary = this.path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(wrapper, null, 2), { flag: 'wx' });
    await rename(temporary, this.path);
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
