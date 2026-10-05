import type { ScenarioSnapshot } from "../../shared/domain/types";

/**
 * 方案对比选择是一项显式状态：
 * - 空字符串表示该侧尚未选择；
 * - 选择以方案 id 表示，并按项目隔离，绝不跨项目派生。
 */
export type ComparisonSide = "baselineId" | "comparisonId";

export interface ComparisonSelection {
  /** 基准方案 id，"" 表示未选择 */
  baselineId: string;
  /** 对照方案 id，"" 表示未选择 */
  comparisonId: string;
}

export const EMPTY_SELECTION: ComparisonSelection = {
  baselineId: "",
  comparisonId: "",
};

export type ComparisonStatus =
  /** 两侧都选了不同方案，可以对比 */
  | "ready"
  /** 至少一侧还没有选择（含当前项目没有任何方案） */
  | "empty"
  /** 只剩一份方案可用，无法组成两份对比 */
  | "single"
  /** 两侧指向同一份方案，对比没有意义 */
  | "same";

export interface ComparisonResolution {
  selection: ComparisonSelection;
  status: ComparisonStatus;
  baseline?: ScenarioSnapshot;
  comparison?: ScenarioSnapshot;
  /** 选择发生变化的原因，需要明确告知用户；无变化时为 undefined */
  notice?: string;
  /** 当前状态的说明性提示（不代表选择被动改变） */
  hint: string;
}

export const EMPTY_HINT = "请先在两侧各选择一份方案，再查看对比结论。";
export const SINGLE_HINT = "当前项目只保存了一份方案，需要两份不同方案才能对比。";
export const SAME_HINT = "基准与对照是同一份方案，请为另一侧另选一份。";

export function sideLabel(side: ComparisonSide): string {
  return side === "baselineId" ? "基准方案" : "对照方案";
}

/**
 * 计算默认预选：保存第一份时不预选；保存第二份时按「旧基准 → 新对照」预选。
 * 仅在用户尚未明确选择过时用于初始展示，不会覆盖任何有效选择。
 */
export function defaultSelectionFor(
  scenarios: ScenarioSnapshot[],
): ComparisonSelection {
  if (scenarios.length < 2) return EMPTY_SELECTION;
  // saveScenario 把新快照插到列表头部：[0] 最新、[1] 次新
  return {
    baselineId: scenarios[1]?.id ?? "",
    comparisonId: scenarios[0]?.id ?? "",
  };
}

function findScenario(
  scenarios: ScenarioSnapshot[],
  id: string,
): ScenarioSnapshot | undefined {
  return id ? scenarios.find((scenario) => scenario.id === id) : undefined;
}

/**
 * 依据当前方案列表解析对比选择。
 *
 * - 选择仍有效：原样保留，绝不静默换成别的组合；
 * - 指向的方案已不存在：清空对应侧并通过 notice 说明；
 * - 当前项目只剩一份方案：如实标记 single，不制造「两份」的假象；
 * - 两侧同一方案：标记 same，不给出对比结论。
 */
export function resolveComparisonSelection(
  scenarios: ScenarioSnapshot[],
  stored: ComparisonSelection,
): ComparisonResolution {
  const known = new Set(scenarios.map((scenario) => scenario.id));
  const missing: ComparisonSide[] = [];
  if (stored.baselineId && !known.has(stored.baselineId))
    missing.push("baselineId");
  if (stored.comparisonId && !known.has(stored.comparisonId))
    missing.push("comparisonId");

  const selection: ComparisonSelection = {
    baselineId: missing.includes("baselineId") ? "" : stored.baselineId,
    comparisonId: missing.includes("comparisonId") ? "" : stored.comparisonId,
  };

  let notice: string | undefined;
  if (missing.length > 0) {
    const labels = missing.map(sideLabel).join("与");
    notice = `${labels}所选的方案已不存在，已清空该选择，请重新选择。`;
  }

  const baseline = findScenario(scenarios, selection.baselineId);
  const comparison = findScenario(scenarios, selection.comparisonId);

  if (!baseline || !comparison) {
    if (scenarios.length === 1) {
      return { selection, status: "single", baseline, comparison, notice, hint: SINGLE_HINT };
    }
    return { selection, status: "empty", baseline, comparison, notice, hint: EMPTY_HINT };
  }

  if (baseline.id === comparison.id) {
    return {
      selection,
      status: "same",
      baseline,
      comparison,
      notice,
      hint: SAME_HINT,
    };
  }
  return {
    selection,
    status: "ready",
    baseline,
    comparison,
    notice,
    hint: "",
  };
}

/**
 * 保存新快照后的选择迁移：
 * - 已有有效选择：原样保留（用户选的两份不被新快照顶掉）；
 * - 尚未明确选择：保存到第二份时按「次新为基准、最新为对照」预选并说明。
 */
export function selectionAfterSave(
  scenarios: ScenarioSnapshot[],
  stored: ComparisonSelection,
): { selection: ComparisonSelection; notice: string } {
  const resolved = resolveComparisonSelection(scenarios, stored);
  const hadExplicit = Boolean(stored.baselineId || stored.comparisonId);
  if (hadExplicit) {
    // 选择明确（哪怕因失效被清空）：不再替用户决定新组合。
    return { selection: resolved.selection, notice: resolved.notice ?? "" };
  }

  const fallback = defaultSelectionFor(scenarios);
  if (fallback.baselineId && fallback.comparisonId) {
    const baselineName =
      scenarios.find((scenario) => scenario.id === fallback.baselineId)?.name ??
      "";
    const comparisonName =
      scenarios.find((scenario) => scenario.id === fallback.comparisonId)
        ?.name ?? "";
    return {
      selection: fallback,
      notice: `已按「${baselineName}」为基准、「${comparisonName}」为对照预选，可在上方自行更换。`,
    };
  }
  return { selection: fallback, notice: "" };
}

/**
 * 删除方案后的选择迁移：
 * - 未被删的一侧：选择保持有效，绝不替换；
 * - 被删的一侧：若还有别的方案，优先用「不是另一侧」的方案补上并说明；
 * - 只剩一份/全没了：清空，交由 resolve 标记 single/empty。
 */
export function selectionAfterRemove(
  remaining: ScenarioSnapshot[],
  stored: ComparisonSelection,
  removed: ScenarioSnapshot,
): { selection: ComparisonSelection; notice: string } {
  const touched: ComparisonSide[] = [];
  if (stored.baselineId === removed.id) touched.push("baselineId");
  if (stored.comparisonId === removed.id) touched.push("comparisonId");
  if (touched.length === 0) return { selection: { ...stored }, notice: "" };

  const next: ComparisonSelection = {
    baselineId:
      stored.baselineId === removed.id ? "" : stored.baselineId,
    comparisonId:
      stored.comparisonId === removed.id ? "" : stored.comparisonId,
  };

  // 两侧原本都指向被删方案（same 状态）：尽量凑成两份不同的方案。
  if (touched.length === 2) {
    if (remaining.length >= 2) {
      return {
        selection: {
          baselineId: remaining[0]!.id,
          comparisonId: remaining[1]!.id,
        },
        notice: `基准与对照所选的「${removed.name}」已删除，已改用「${remaining[0]!.name}」与「${remaining[1]!.name}」对比。`,
      };
    }
    return {
      selection: EMPTY_SELECTION,
      notice:
        remaining.length === 1
          ? `所选的「${removed.name}」已删除，项目中只剩一份方案，无法继续对比。`
          : `所选的「${removed.name}」已删除，项目中已没有任何方案。`,
    };
  }

  const side = touched[0]!;
  const otherSide: ComparisonSide =
    side === "baselineId" ? "comparisonId" : "baselineId";
  const otherId = next[otherSide];
  const replacement = remaining.find((scenario) => scenario.id !== otherId);
  if (replacement) {
    next[side] = replacement.id;
    return {
      selection: next,
      notice: `原${sideLabel(side)}「${removed.name}」已删除，已改用「${replacement.name}」作为${sideLabel(side)}。`,
    };
  }

  const tail =
    remaining.length === 1
      ? "项目中只剩一份方案，无法继续对比，请再保存一份。"
      : "项目中已没有其他方案，请重新选择。";
  return {
    selection: next,
    notice: `${sideLabel(side)}所选的「${removed.name}」已删除。${tail}`,
  };
}
