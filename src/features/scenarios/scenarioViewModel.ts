import {
  EMPTY_SELECTION,
  type ComparisonSelection,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type SimulationResult,
} from "../../shared/domain/types";

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
}

/** 触发对比选择重新校验的操作；决定向用户解释变更的措辞。 */
export type SelectionReason =
  "save" | "remove" | "restore" | "switch" | "duplicate" | "import";

export interface SelectionReconcileResult {
  project: LatencyProject;
  /** 选择是否被改动（仅当确实调整时才需要提示）。 */
  changed: boolean;
  /** 调整后的选择（不足两份方案时两侧均为空）。 */
  selection: ComparisonSelection;
  /** 明确告诉用户选择变成了什么、为什么；为空表示选择保持有效。 */
  notice: string;
}

function nameOf(scenarios: ScenarioSnapshot[], id: string): string | undefined {
  return scenarios.find((scenario) => scenario.id === id)?.name;
}

/**
 * 对比选择的唯一归一化入口。保存、删除、恢复、复制、切换项目、载入数据之后
 * 都经过这里：选择指向的方案仍存在且两侧不同则保持不变；否则给出确定的结果
 * 与一条说明，界面绝不悄悄换成另外两份方案。
 *
 * 方案列表约定为新保存的排在最前（见 saveScenario），因此默认配对取
 * “较早的方案为基准、最新的方案为对照”。
 */
export function reconcileScenarioSelection(
  project: LatencyProject,
  reason: SelectionReason,
  removedName?: string,
): SelectionReconcileResult {
  const scenarios = project.scenarios;
  const current = project.comparison ?? EMPTY_SELECTION;

  if (scenarios.length < 2) {
    const alreadyEmpty =
      current.baselineId === "" && current.comparisonId === "";
    // 原本就没有对比选择（例如新建项目里只有一份方案）：状态确定，无需解释。
    if (alreadyEmpty)
      return {
        project,
        changed: false,
        selection: EMPTY_SELECTION,
        notice: "",
      };

    let notice = "";
    if (reason === "remove" && removedName) {
      notice =
        scenarios.length === 0
          ? `已删除方案“${removedName}”，当前项目里没有可对比的方案，对比选择已清空。`
          : `已删除方案“${removedName}”，当前只剩一份方案，无法构成对比，对比选择已清空。`;
    } else if (scenarios.length === 1) {
      const only = scenarios[0]!;
      notice = `当前只有“${only.name}”一份方案，需再保存一份才能对比，对比选择暂不可用。`;
    }
    return {
      project: { ...project, comparison: EMPTY_SELECTION },
      changed: true,
      selection: EMPTY_SELECTION,
      notice,
    };
  }

  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const baselineExists = byId.has(current.baselineId);
  const comparisonExists = byId.has(current.comparisonId);
  const distinct =
    baselineExists &&
    comparisonExists &&
    current.baselineId !== current.comparisonId;

  if (distinct)
    return {
      project,
      changed: false,
      selection: current,
      notice: "",
    };

  // 默认配对：列表末位（最早）为基准，首位（最新）为对照。
  const fallbackBaseline = scenarios[scenarios.length - 1]!;
  const fallbackComparison = scenarios[0]!;
  const defaultSelection: ComparisonSelection = {
    baselineId: fallbackBaseline.id,
    comparisonId: fallbackComparison.id,
  };
  const defaultNotice = `已自动选择“${fallbackBaseline.name}”为基准、“${fallbackComparison.name}”为对照，可在上方手动调整。`;

  // 恰好一侧失效：保留仍存在的那侧，另一侧补齐，并点名原因。
  if (baselineExists !== comparisonExists) {
    const survivor = baselineExists ? current.baselineId : current.comparisonId;
    const survivorName = nameOf(scenarios, survivor) ?? "";
    const candidate = scenarios.find((scenario) => scenario.id !== survivor)!;
    const selection: ComparisonSelection = baselineExists
      ? { baselineId: survivor, comparisonId: candidate.id }
      : { baselineId: candidate.id, comparisonId: survivor };
    const notice =
      reason === "remove" && removedName
        ? baselineExists
          ? `已删除对照方案“${removedName}”，基准“${survivorName}”保留，对照已改为“${candidate.name}”。`
          : `已删除基准方案“${removedName}”，对照“${survivorName}”保留，基准已改为“${candidate.name}”。`
        : baselineExists
          ? `原对照方案已不存在，基准“${survivorName}”保留，对照已改为“${candidate.name}”。`
          : `原基准方案已不存在，对照“${survivorName}”保留，基准已改为“${candidate.name}”。`;
    return {
      project: { ...project, comparison: selection },
      changed: true,
      selection,
      notice,
    };
  }

  // 两侧都缺失，或两侧指向同一份方案：落到确定的默认配对。
  let notice: string;
  if (reason === "remove" && removedName) {
    notice =
      current.baselineId === current.comparisonId && baselineExists
        ? defaultNotice
        : `已删除方案“${removedName}”，${defaultNotice}`;
  } else if (reason === "save") {
    notice = `已保存第二份方案，默认以较早的“${fallbackBaseline.name}”为基准、最新的“${fallbackComparison.name}”为对照。`;
  } else if (reason === "switch") {
    notice = `该项目此前未指定对比方案，${defaultNotice}`;
  } else if (reason === "import") {
    notice = `载入的对比选择已失效，${defaultNotice}`;
  } else {
    notice = defaultNotice;
  }
  return {
    project: { ...project, comparison: defaultSelection },
    changed: true,
    selection: defaultSelection,
    notice,
  };
}

/**
 * 用户手动切换某一侧。选择同一份方案时不允许基准与对照重合：自动把另一侧
 * 让开，并明确说明调整结果。
 */
export function selectScenarioSide(
  project: LatencyProject,
  side: keyof ComparisonSelection,
  id: string,
): { project: LatencyProject; notice: string } {
  const scenarios = project.scenarios;
  if (!scenarios.some((scenario) => scenario.id === id))
    return { project, notice: "" };
  const current = project.comparison ?? EMPTY_SELECTION;
  const otherSide: keyof ComparisonSelection =
    side === "baselineId" ? "comparisonId" : "baselineId";
  const next: ComparisonSelection = { ...current, [side]: id };
  let notice = "";
  if (current[otherSide] === id) {
    const replacement = scenarios.find((scenario) => scenario.id !== id);
    if (replacement) {
      next[otherSide] = replacement.id;
      notice =
        side === "baselineId"
          ? `基准已切换为“${nameOf(scenarios, id) ?? ""}”；对照不能与基准相同，已自动改为“${replacement.name}”。`
          : `对照已切换为“${nameOf(scenarios, id) ?? ""}”；基准不能与对照相同，已自动改为“${replacement.name}”。`;
    }
  }
  return { project: { ...project, comparison: next }, notice };
}

function describeNodeChanges(
  before: RequestNode,
  after: RequestNode,
): string[] {
  const changes: string[] = [];
  if (before.durationMs !== after.durationMs)
    changes.push(
      `${before.name} · 耗时 ${before.durationMs} → ${after.durationMs} ms`,
    );
  if (before.jitterMs !== after.jitterMs)
    changes.push(
      `${before.name} · 波动 ±${before.jitterMs} → ±${after.jitterMs} ms`,
    );
  if (before.timeoutMs !== after.timeoutMs)
    changes.push(
      `${before.name} · 超时 ${before.timeoutMs} → ${after.timeoutMs} ms`,
    );
  if (before.retryCount !== after.retryCount)
    changes.push(
      `${before.name} · 重试 ${before.retryCount} → ${after.retryCount} 次`,
    );
  if (before.failureRate !== after.failureRate)
    changes.push(
      `${before.name} · 失败率 ${before.failureRate} → ${after.failureRate}%`,
    );
  if (before.fallbackNodeId !== after.fallbackNodeId)
    changes.push(`${before.name} · 降级目标已调整`);
  if (before.dependencyIds.join("|") !== after.dependencyIds.join("|"))
    changes.push(`${before.name} · 前置依赖已调整`);
  return changes;
}

export function compareScenarios(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): ScenarioComparison {
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const comparisonNodes = new Map(
    comparison.nodes.map((node) => [node.id, node]),
  );
  const changes = [
    ...baseline.nodes.flatMap((node) => {
      const next = comparisonNodes.get(node.id);
      return next
        ? describeNodeChanges(node, next)
        : [`${node.name} · 已从对照方案移除`];
    }),
    ...comparison.nodes
      .filter((node) => !baselineNodes.has(node.id))
      .map((node) => `${node.name} · 新增请求节点`),
  ];
  if (baseline.concurrencyLimit !== comparison.concurrencyLimit)
    changes.unshift(
      `并发上限 · ${baseline.concurrencyLimit ?? "不限"} → ${comparison.concurrencyLimit ?? "不限"}`,
    );
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
  };
}

export function saveScenario(
  project: LatencyProject,
  result: SimulationResult,
  name: string,
): LatencyProject {
  if (
    result.warnings.some(
      (warning) => warning.includes("检测到循环") || warning.includes("不能"),
    )
  )
    return project;
  const snapshot: ScenarioSnapshot = {
    id: crypto.randomUUID(),
    name: name.trim() || `方案 ${project.scenarios.length + 1}`,
    createdAt: Date.now(),
    concurrencyLimit: project.concurrencyLimit,
    nodes: structuredClone(project.nodes),
    completionMs: result.completionMs,
    criticalPath: [...result.criticalPath],
  };
  return {
    ...project,
    scenarios: [snapshot, ...project.scenarios],
    updatedAt: Date.now(),
  };
}

export function removeScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  return {
    ...project,
    scenarios: project.scenarios.filter(
      (scenario) => scenario.id !== scenarioId,
    ),
    updatedAt: Date.now(),
  };
}

export function restoreScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  const snapshot = project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  );
  if (!snapshot) return project;
  return {
    ...project,
    nodes: structuredClone(snapshot.nodes),
    concurrencyLimit: snapshot.concurrencyLimit,
    updatedAt: Date.now(),
  };
}
