import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectRepository } from "../../shared/repositories/projectRepository";
import type {
  LatencyProject,
  SimulationMode,
  WorkspaceDocument,
} from "../../shared/domain/types";
import {
  createProject,
  duplicateProject,
  removeProject,
  renameProject,
  selectProject,
  updateProject,
} from "../projects/projectViewModel";
import {
  addRequestNode,
  getGraphAnalysis,
  patchRequestNode,
  removeRequestNode,
  setConcurrency,
  toggleDependency,
} from "../graph-editor/graphViewModel";
import {
  compareScenarios,
  reconcileScenarioSelection,
  removeScenario,
  restoreScenario,
  saveScenario,
  selectScenarioSide,
  type ScenarioComparison,
  type SelectionReason,
} from "../scenarios/scenarioViewModel";
import { simulateProject } from "../../shared/domain/simulation";

export type LabStatus =
  "loading" | "ready" | "editing" | "simulating" | "error" | "completed";
export type LabModule =
  "projects" | "graph" | "simulation" | "scenarios" | "archive";

/**
 * 对当前项目执行一次变更，并在变更后统一重新校验方案对比选择。
 * 返回需要展示给用户的说明（选择保持有效时为空）。
 */
function applyProjectChange(
  document: WorkspaceDocument,
  nextProject: LatencyProject,
  reason: SelectionReason,
  removedName?: string,
): { document: WorkspaceDocument; notice: string } {
  const reconciled = reconcileScenarioSelection(
    nextProject,
    reason,
    removedName,
  );
  return {
    document: updateProject(document, reconciled.project),
    notice: reconciled.notice,
  };
}

export function useLatencyLab() {
  const repository = useMemo(() => new ProjectRepository(), []);
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const documentRef = useRef<WorkspaceDocument | null>(null);
  const [status, setStatus] = useState<LabStatus>("loading");
  const [module, setModule] = useState<LabModule>("simulation");
  const [mode, setMode] = useState<SimulationMode>("expected");
  const [notice, setNotice] = useState("");
  const [persisted, setPersisted] = useState<"saving" | "saved" | "error">(
    "saved",
  );
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const activeProject =
    document?.projects.find(
      (project) => project.id === document.activeProjectId,
    ) ?? document?.projects[0];
  const result = useMemo(
    () => (activeProject ? simulateProject(activeProject, mode) : undefined),
    [activeProject, mode],
  );
  const graphAnalysis = useMemo(
    () => (activeProject ? getGraphAnalysis(activeProject) : undefined),
    [activeProject],
  );
  const scenarioList = activeProject?.scenarios ?? [];
  // 选择只从明确的项目状态读取，不再做任何静默兜底；指向的方案不存在时直接
  // 显示为“无选择”，由归一化逻辑负责修复，绝不悄悄显示成另外一份方案。
  const findScenario = (id: string) =>
    scenarioList.find((scenario) => scenario.id === id);
  const baselineScenario = activeProject?.comparison.baselineId
    ? findScenario(activeProject.comparison.baselineId)
    : undefined;
  const comparisonScenario = activeProject?.comparison.comparisonId
    ? findScenario(activeProject.comparison.comparisonId)
    : undefined;
  const scenarioComparison: ScenarioComparison | undefined =
    baselineScenario &&
    comparisonScenario &&
    baselineScenario.id !== comparisonScenario.id
      ? compareScenarios(baselineScenario, comparisonScenario)
      : undefined;
  const simulationValid =
    Boolean(activeProject) &&
    result?.entries.length === activeProject?.nodes.length;

  useEffect(() => {
    let mounted = true;
    void repository
      .load()
      .then(({ document: loaded, recovered }) => {
        if (!mounted) return;
        // 载入即导入：统一校验每个项目自己的对比选择，避免切换到其他项目时
        // 才发现旧选择已失效；只持久化真正发生变化的项目。
        let nextDocument = loaded;
        let loadNotice = recovered
          ? "已载入示例工作区；后续修改会自动保存到此设备。"
          : "";
        const repairedProjects: LatencyProject[] = [];
        loaded.projects.forEach((project) => {
          const reconciled = reconcileScenarioSelection(project, "import");
          if (reconciled.project !== project) {
            repairedProjects.push(reconciled.project);
            if (project.id === loaded.activeProjectId && reconciled.notice)
              loadNotice = loadNotice
                ? `${loadNotice}${reconciled.notice}`
                : reconciled.notice;
          }
        });
        if (repairedProjects.length > 0) {
          nextDocument = repairedProjects.reduce(
            (doc, repaired) => updateProject(doc, repaired),
            loaded,
          );
          documentRef.current = nextDocument;
          queue.current = queue.current.then(() =>
            repository.save(nextDocument),
          );
        }
        documentRef.current = nextDocument;
        setDocument(nextDocument);
        setStatus("ready");
        setNotice(loadNotice);
      })
      .catch(() => {
        if (!mounted) return;
        setStatus("error");
        setNotice("本地项目读取失败，刷新页面可再次尝试。");
      });
    return () => {
      mounted = false;
    };
  }, [repository]);

  const commit = useCallback(
    (
      next: WorkspaceDocument,
      nextStatus: LabStatus = "editing",
      explicitNotice?: string,
    ) => {
      const currentRevision = ++revision.current;
      documentRef.current = next;
      setDocument(next);
      setStatus(nextStatus);
      setNotice(explicitNotice ?? "");
      setPersisted("saving");
      queue.current = queue.current
        .then(() => repository.save(next))
        .then(() => {
          if (revision.current === currentRevision) {
            setPersisted("saved");
            if (nextStatus === "editing") setStatus("completed");
          }
        })
        .catch(() => {
          if (revision.current === currentRevision) {
            setPersisted("error");
            setStatus("error");
            setNotice(
              explicitNotice
                ? `${explicitNotice}自动保存失败，数据仍保留在当前页面，请重试保存。`
                : "保存失败。数据仍保留在当前页面，请重试保存。",
            );
          }
        });
    },
    [repository],
  );

  const editProject = useCallback(
    (project: LatencyProject, explicitNotice: string) => {
      const current = documentRef.current;
      if (!current) return;
      // 恢复不改变方案列表，但仍统一过一次校验以保证选择状态确定。
      const outcome = applyProjectChange(current, project, "restore");
      commit(outcome.document, "editing", explicitNotice || outcome.notice);
    },
    [commit],
  );

  const chooseProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (!current) return;
      const switched = selectProject(current, id);
      const target = switched.projects.find((project) => project.id === id);
      if (!target) return;
      // 切换项目后选择绝不串项目：按目标项目自己保存的选择重新校验。
      const reconciled = reconcileScenarioSelection(target, "switch");
      commit(
        updateProject(switched, reconciled.project),
        "ready",
        reconciled.notice || undefined,
      );
    },
    [commit],
  );

  const newProject = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(createProject(current), "editing");
  }, [commit]);

  const renameActive = useCallback(
    (title: string) => {
      if (activeProject) {
        const current = documentRef.current;
        if (current)
          commit(
            updateProject(current, renameProject(activeProject, title)),
            "editing",
          );
      }
    },
    [activeProject, commit],
  );

  const duplicateActive = useCallback(() => {
    const current = documentRef.current;
    if (current && activeProject) {
      // 复制出的项目不携带方案快照，对比选择也是空的，不会继承旧项目的选择。
      const duplicated = duplicateProject(current, activeProject);
      commit(
        duplicated,
        "editing",
        "已复制项目；副本不包含方案快照，对比选择从空状态开始。",
      );
    }
  }, [activeProject, commit]);

  const deleteProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (!current) return;
      if (current.projects.length <= 1) {
        setNotice("至少保留一个链路项目。");
        return;
      }
      const removed = removeProject(current, id);
      const target =
        removed.projects.find(
          (project) => project.id === removed.activeProjectId,
        ) ?? removed.projects[0];
      if (!target) return;
      // 删除后落到另一个项目：用该项目自己的选择，绝不沿用被删项目的 ID。
      const reconciled = reconcileScenarioSelection(target, "switch");
      commit(
        updateProject(removed, reconciled.project),
        "editing",
        reconciled.notice || undefined,
      );
    },
    [commit],
  );

  const addNode = useCallback(() => {
    if (activeProject) {
      const current = documentRef.current;
      if (current)
        commit(
          updateProject(current, addRequestNode(activeProject)),
          "editing",
        );
    }
  }, [activeProject, commit]);
  const patchNode = useCallback(
    (id: string, patch: Parameters<typeof patchRequestNode>[2]) => {
      if (activeProject) {
        const current = documentRef.current;
        if (current)
          commit(
            updateProject(current, patchRequestNode(activeProject, id, patch)),
            "editing",
          );
      }
    },
    [activeProject, commit],
  );
  const deleteNode = useCallback(
    (id: string) => {
      if (activeProject) {
        const current = documentRef.current;
        if (current)
          commit(
            updateProject(current, removeRequestNode(activeProject, id)),
            "editing",
          );
      }
    },
    [activeProject, commit],
  );
  const setNodeDependency = useCallback(
    (id: string, dependencyId: string) => {
      if (!activeProject) return;
      const outcome = toggleDependency(activeProject, id, dependencyId);
      if (outcome.error) setNotice(outcome.error);
      else {
        const current = documentRef.current;
        if (current) commit(updateProject(current, outcome.project), "editing");
      }
    },
    [activeProject, commit],
  );
  const setLimit = useCallback(
    (limit: number | null) => {
      if (activeProject) {
        const current = documentRef.current;
        if (current)
          commit(
            updateProject(current, setConcurrency(activeProject, limit)),
            "editing",
          );
      }
    },
    [activeProject, commit],
  );

  const simulate = useCallback(
    (nextMode = mode) => {
      if (!activeProject) return undefined;
      setStatus("simulating");
      const result = simulateProject(activeProject, nextMode);
      setMode(nextMode);
      setStatus(
        result.warnings.some((warning) => warning.includes("循环"))
          ? "error"
          : "completed",
      );
      return result;
    },
    [activeProject, mode],
  );

  const saveSnapshot = useCallback(
    (name: string): boolean => {
      if (!activeProject) return false;
      const result = simulateProject(activeProject, mode);
      if (result.entries.length !== activeProject.nodes.length) {
        setNotice(result.warnings[0] ?? "请先修复链路配置再保存方案。");
        return false;
      }
      const withSnapshot = saveScenario(activeProject, result, name);
      const snapshotName = withSnapshot.scenarios[0]?.name ?? "新方案";
      // 保存后保持原有对比选择有效；仅在不足两份或第二份刚出现时才说明变化。
      const reconciled = reconcileScenarioSelection(withSnapshot, "save");
      const current = documentRef.current;
      if (!current) return false;
      const savedNotice =
        withSnapshot.scenarios.length === 1
          ? `方案快照“${snapshotName}”已保存；再保存一份方案即可选择基准与对照。`
          : `方案快照“${snapshotName}”已保存，当前对比选择保持不变。`;
      commit(
        updateProject(current, reconciled.project),
        "editing",
        reconciled.notice || savedNotice,
      );
      return true;
    },
    [activeProject, commit, mode],
  );

  const removeSavedScenario = useCallback(
    (id: string) => {
      if (!activeProject) return;
      const removedScenario = activeProject.scenarios.find(
        (scenario) => scenario.id === id,
      );
      if (!removedScenario) return;
      const current = documentRef.current;
      if (!current) return;
      const next = removeScenario(activeProject, id);
      const outcome = applyProjectChange(
        current,
        next,
        "remove",
        removedScenario.name,
      );
      // 删除不在对比中的方案时也要确认结果，避免“没有任何说明”。
      const fallback = `已删除方案“${removedScenario.name}”，当前对比的两份方案保持不变。`;
      commit(outcome.document, "editing", outcome.notice || fallback);
    },
    [activeProject, commit],
  );

  const restoreSavedScenario = useCallback(
    (id: string) => {
      if (!activeProject) return;
      const snapshot = activeProject.scenarios.find(
        (scenario) => scenario.id === id,
      );
      if (!snapshot) return;
      const next = restoreScenario(activeProject, id);
      // 恢复只改图参数，不动方案列表，对比选择天然保持；但要明确告知。
      editProject(
        next,
        `已将当前链路参数恢复为方案“${snapshot.name}”，对比选择保持不变。`,
      );
    },
    [activeProject, editProject],
  );

  const selectComparisonScenario = useCallback(
    (side: "baselineId" | "comparisonId", id: string) => {
      if (!activeProject) return;
      const { project: next, notice: sideNotice } = selectScenarioSide(
        activeProject,
        side,
        id,
      );
      const current = documentRef.current;
      if (current)
        commit(updateProject(current, next), "ready", sideNotice || undefined);
    },
    [activeProject, commit],
  );

  const retrySave = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(current);
  }, [commit]);

  return {
    document,
    activeProject,
    result,
    graphAnalysis,
    simulationValid,
    status,
    module,
    setModule,
    mode,
    setMode,
    notice,
    setNotice,
    persisted,
    chooseProject,
    newProject,
    renameActive,
    duplicateActive,
    deleteProject,
    addNode,
    patchNode,
    deleteNode,
    setNodeDependency,
    setLimit,
    simulate,
    saveSnapshot,
    removeSavedScenario,
    restoreSavedScenario,
    retrySave,
    scenarioList,
    baselineScenario,
    comparisonScenario,
    scenarioComparison,
    selectComparisonScenario,
  };
}
