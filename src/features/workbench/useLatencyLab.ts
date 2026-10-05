import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectRepository } from "../../shared/repositories/projectRepository";
import type {
  LatencyProject,
  ScenarioSnapshot,
  SimulationMode,
  WorkspaceDocument,
} from "../../shared/domain/types";
import {
  createProject,
  duplicateProject,
  renameProject,
  selectProject,
} from "../projects/projectViewModel";
import {
  addRequestNode,
  patchRequestNode,
  removeRequestNode,
  setConcurrency,
  toggleDependency,
  getGraphAnalysis,
} from "../graph-editor/graphViewModel";
import {
  compareScenarios,
  removeScenario,
  restoreScenario,
  saveScenario,
  type ScenarioComparison,
} from "../scenarios/scenarioViewModel";
import {
  EMPTY_SELECTION,
  resolveComparisonSelection,
  selectionAfterRemove,
  selectionAfterSave,
  type ComparisonSelection,
  type ComparisonSide,
} from "../scenarios/comparisonSelection";
import { removeProject, updateProject } from "../projects/projectViewModel";
import { simulateProject } from "../../shared/domain/simulation";

export type LabStatus =
  "loading" | "ready" | "editing" | "simulating" | "error" | "completed";
export type LabModule =
  "projects" | "graph" | "simulation" | "scenarios" | "archive";

export function useLatencyLab() {
  const repository = useMemo(() => new ProjectRepository(), []);
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const documentRef = useRef<WorkspaceDocument | null>(null);
  const [status, setStatus] = useState<LabStatus>("loading");
  const [module, setModule] = useState<LabModule>("simulation");
  const [mode, setMode] = useState<SimulationMode>("expected");
  // 对比选择按项目隔离，绝不跨项目派生：key 为项目 id。
  const [comparisonSelections, setComparisonSelections] = useState<
    Record<string, ComparisonSelection>
  >({});
  const [comparisonNotice, setComparisonNotice] = useState("");
  const [notice, setNotice] = useState("");
  const [persisted, setPersisted] = useState<"saving" | "saved" | "error">(
    "saved",
  );
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const lastActiveProjectId = useRef<string>("");
  // 选择迁移由归一化 effect 在项目数据更新后统一执行，处理器只登记待处理操作，
  // 避免「项目列表」和「选择 state」两个更新之间的时序竞争。
  type PendingSelectionChange =
    | { kind: "save" }
    | { kind: "remove"; removed: ScenarioSnapshot }
    | { kind: "restore"; name: string }
    | { kind: "clear" };
  const pendingSelectionChange = useRef<PendingSelectionChange | null>(null);
  const lastScenariosKey = useRef("");
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
  const scenarioList = useMemo(
    () => activeProject?.scenarios ?? [],
    [activeProject],
  );
  const storedSelection = activeProject
    ? (comparisonSelections[activeProject.id] ?? EMPTY_SELECTION)
    : EMPTY_SELECTION;
  // 解析是纯函数：选择有效就原样保留，失效则清空并给出原因，绝不静默换成别的方案。
  const comparisonResolution = useMemo(
    () => resolveComparisonSelection(scenarioList, storedSelection),
    [scenarioList, storedSelection],
  );
  const baselineScenario = comparisonResolution.baseline;
  const comparisonScenario = comparisonResolution.comparison;
  const scenarioComparison: ScenarioComparison | undefined =
    comparisonResolution.status === "ready" &&
    baselineScenario &&
    comparisonScenario
      ? compareScenarios(baselineScenario, comparisonScenario)
      : undefined;
  const simulationValid =
    Boolean(activeProject) &&
    result?.entries.length === activeProject?.nodes.length;

  const updateSelection = useCallback(
    (projectId: string, selection: ComparisonSelection) => {
      setComparisonSelections((current) => ({
        ...current,
        [projectId]: selection,
      }));
    },
    [],
  );

  const selectComparisonScenario = useCallback(
    (side: ComparisonSide, id: string) => {
      if (!activeProject) return;
      const projectId = activeProject.id;
      // 用户手动选择是显式状态：允许两侧相同（界面会提示），但绝不自动替他改另一侧。
      setComparisonSelections((current) => {
        const previous = current[projectId] ?? EMPTY_SELECTION;
        return {
          ...current,
          [projectId]: { ...previous, [side]: id },
        };
      });
      setComparisonNotice("");
      pendingSelectionChange.current = null;
    },
    [activeProject],
  );

  // 切换项目或方案列表变化（保存、删除、复制、导入/恢复数据）后，统一归一化选择：
  // 失效的 id 必须清空并说明，绝不让选择静默指向别的方案；选择按项目隔离。
  useEffect(() => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    if (lastActiveProjectId.current !== projectId) {
      // 切换项目：每个项目的对比选择独立，提示也不跨项目携带。
      lastActiveProjectId.current = projectId;
      setComparisonNotice("");
    }

    const scenariosKey = `${projectId}:${activeProject.updatedAt}:${activeProject.scenarios
      .map((scenario) => scenario.id)
      .join("|")}`;
    const projectChanged = lastScenariosKey.current !== scenariosKey;
    lastScenariosKey.current = scenariosKey;

    const stored = comparisonSelections[projectId] ?? EMPTY_SELECTION;
    let nextSelection = stored;
    let notice = "";

    if (projectChanged && pendingSelectionChange.current) {
      // 保存/删除/恢复引发的确定性迁移（在新方案列表上计算）。
      const pending = pendingSelectionChange.current;
      pendingSelectionChange.current = null;
      if (pending.kind === "save") {
        const migrated = selectionAfterSave(activeProject.scenarios, stored);
        nextSelection = migrated.selection;
        notice = migrated.notice;
      } else if (pending.kind === "remove") {
        const migrated = selectionAfterRemove(
          activeProject.scenarios,
          stored,
          pending.removed,
        );
        nextSelection = migrated.selection;
        notice = migrated.notice;
      } else if (pending.kind === "restore") {
        notice = pending.name
          ? `已将当前编排恢复为「${pending.name}」的参数；对比选择保持不变。`
          : "";
      } else {
        notice = "";
      }
      setComparisonNotice(notice);
    } else {
      // 无显式操作：仅做失效归一化（例如外部导入导致 id 消失）。
      const resolved = resolveComparisonSelection(
        activeProject.scenarios,
        stored,
      );
      nextSelection = resolved.selection;
      if (
        stored.baselineId !== nextSelection.baselineId ||
        stored.comparisonId !== nextSelection.comparisonId
      ) {
        if (resolved.notice) setComparisonNotice(resolved.notice);
      }
    }

    if (
      stored.baselineId !== nextSelection.baselineId ||
      stored.comparisonId !== nextSelection.comparisonId
    ) {
      updateSelection(projectId, nextSelection);
    }
  }, [activeProject, comparisonSelections, updateSelection]);

  // 项目被整体替换（复制项目、导入工作区等）后，清掉已不存在项目的选择记录。
  useEffect(() => {
    if (!document) return;
    const liveIds = new Set(document.projects.map((project) => project.id));
    setComparisonSelections((current) => {
      const keys = Object.keys(current);
      if (keys.every((id) => liveIds.has(id))) return current;
      return Object.fromEntries(keys.filter((id) => liveIds.has(id)).map((id) => [id, current[id]!]));
    });
  }, [document]);

  useEffect(() => {
    let mounted = true;
    void repository
      .load()
      .then(({ document: loaded, recovered }) => {
        if (!mounted) return;
        documentRef.current = loaded;
        setDocument(loaded);
        setStatus("ready");
        if (recovered)
          setNotice("已载入示例工作区；后续修改会自动保存到此设备。");
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
    (next: WorkspaceDocument, nextStatus: LabStatus = "editing") => {
      const currentRevision = ++revision.current;
      documentRef.current = next;
      setDocument(next);
      setStatus(nextStatus);
      setNotice("");
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
            setNotice("保存失败。数据仍保留在当前页面，请重试保存。");
          }
        });
    },
    [repository],
  );

  const editProject = useCallback(
    (project: LatencyProject) => {
      const current = documentRef.current;
      if (current) commit(updateProject(current, project));
    },
    [commit],
  );

  const chooseProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current) commit(selectProject(current, id), "ready");
    },
    [commit],
  );

  const newProject = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(createProject(current), "editing");
  }, [commit]);

  const renameActive = useCallback(
    (title: string) => {
      if (activeProject) editProject(renameProject(activeProject, title));
    },
    [activeProject, editProject],
  );

  const duplicateActive = useCallback(() => {
    const current = documentRef.current;
    if (current && activeProject)
      commit(duplicateProject(current, activeProject), "editing");
  }, [activeProject, commit]);

  const deleteProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current && current.projects.length > 1)
        commit(removeProject(current, id), "editing");
      else setNotice("至少保留一个链路项目。");
    },
    [commit],
  );

  const addNode = useCallback(() => {
    if (activeProject) editProject(addRequestNode(activeProject));
  }, [activeProject, editProject]);
  const patchNode = useCallback(
    (id: string, patch: Parameters<typeof patchRequestNode>[2]) => {
      if (activeProject)
        editProject(patchRequestNode(activeProject, id, patch));
    },
    [activeProject, editProject],
  );
  const deleteNode = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeRequestNode(activeProject, id));
    },
    [activeProject, editProject],
  );
  const setNodeDependency = useCallback(
    (id: string, dependencyId: string) => {
      if (!activeProject) return;
      const outcome = toggleDependency(activeProject, id, dependencyId);
      if (outcome.error) setNotice(outcome.error);
      else editProject(outcome.project);
    },
    [activeProject, editProject],
  );
  const setLimit = useCallback(
    (limit: number | null) => {
      if (activeProject) editProject(setConcurrency(activeProject, limit));
    },
    [activeProject, editProject],
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
      const next = saveScenario(activeProject, result, name);
      // 保存不顶掉已有选择；迁移在 effect 里依据新方案列表统一完成。
      pendingSelectionChange.current = { kind: "save" };
      editProject(next);
      setNotice("方案快照已保存。");
      return true;
    },
    [activeProject, editProject, mode],
  );

  const removeSavedScenario = useCallback(
    (id: string) => {
      if (!activeProject) return;
      const removed = activeProject.scenarios.find(
        (scenario) => scenario.id === id,
      );
      const next = removeScenario(activeProject, id);
      if (removed) pendingSelectionChange.current = { kind: "remove", removed };
      editProject(next);
    },
    [activeProject, editProject],
  );
  const restoreSavedScenario = useCallback(
    (id: string) => {
      if (!activeProject) return;
      // 恢复只覆盖工作区参数，方案列表与对比选择都保持不变。
      editProject(restoreScenario(activeProject, id));
      const name =
        activeProject.scenarios.find((scenario) => scenario.id === id)?.name ??
        "";
      pendingSelectionChange.current = { kind: "restore", name };
    },
    [activeProject, editProject],
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
    comparisonSelection: comparisonResolution.selection,
    comparisonStatus: comparisonResolution.status,
    comparisonHint: comparisonResolution.hint,
    comparisonNotice,
    dismissComparisonNotice: () => setComparisonNotice(""),
    selectComparisonScenario,
  };
}
