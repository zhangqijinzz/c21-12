import { describe, expect, it } from "vitest";
import {
  reconcileScenarioSelection,
  saveScenario,
  selectScenarioSide,
} from "../src/features/scenarios/scenarioViewModel";
import { duplicateProject } from "../src/features/projects/projectViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EMPTY_SELECTION,
  type LatencyProject,
  type ScenarioSnapshot,
} from "../src/shared/domain/types";

function snapshot(
  id: string,
  name: string,
  completionMs = 100,
): ScenarioSnapshot {
  return {
    id,
    name,
    createdAt: 1,
    concurrencyLimit: null,
    nodes: [],
    completionMs,
    criticalPath: [],
  };
}

function projectWith(
  scenarios: ScenarioSnapshot[],
  comparison = EMPTY_SELECTION,
): LatencyProject {
  return {
    id: "p1",
    title: "测试链路",
    nodes: [],
    concurrencyLimit: null,
    scenarios,
    comparison,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("comparison selection is explicit state", () => {
  it("saving additional snapshots never disturbs a valid chosen pair", () => {
    const a = snapshot("a", "方案 A", 300);
    const b = snapshot("b", "方案 B", 200);
    // 列表顺序为新到旧，选择是更早的 b 对 a（用户自选的非默认顺序）。
    const initial = projectWith([a, b], {
      baselineId: "b",
      comparisonId: "a",
    });
    const c = snapshot("c", "方案 C", 100);
    const next = projectWith([c, a, b], initial.comparison);

    const result = reconcileScenarioSelection(next, "save");

    expect(result.changed).toBe(false);
    expect(result.notice).toBe("");
    expect(result.selection).toEqual({ baselineId: "b", comparisonId: "a" });
    expect(result.project.comparison).toEqual({
      baselineId: "b",
      comparisonId: "a",
    });
  });

  it("saving the second snapshot establishes a named default pair with an explanation", () => {
    const withSecond = projectWith(
      [snapshot("b", "方案 B"), snapshot("a", "方案 A")],
      EMPTY_SELECTION,
    );

    const result = reconcileScenarioSelection(withSecond, "save");

    expect(result.changed).toBe(true);
    expect(result.selection).toEqual({ baselineId: "a", comparisonId: "b" });
    expect(result.notice).toContain("方案 A");
    expect(result.notice).toContain("方案 B");
  });

  it("a single snapshot empties the pair instead of comparing it with itself", () => {
    const project = projectWith([snapshot("a", "仅存方案")], {
      baselineId: "a",
      comparisonId: "b",
    });

    const result = reconcileScenarioSelection(project, "remove", "方案 B");

    expect(result.selection).toEqual(EMPTY_SELECTION);
    expect(result.notice).toContain("只剩一份方案");
  });

  it("deleting a selected side keeps the survivor and names the replacement", () => {
    const b = snapshot("b", "方案 B");
    const c = snapshot("c", "方案 C");
    const project = projectWith([c, b], {
      baselineId: "a",
      comparisonId: "b",
    });

    const result = reconcileScenarioSelection(project, "remove", "方案 A");

    expect(result.selection.comparisonId).toBe("b");
    expect(result.selection.baselineId).toBe("c");
    expect(result.notice).toContain("已删除基准方案“方案 A”");
    expect(result.notice).toContain("对照“方案 B”保留");
    expect(result.notice).toContain("方案 C");
  });

  it("deleting the comparison side preserves the baseline and refills the comparison", () => {
    const a = snapshot("a", "方案 A");
    const c = snapshot("c", "方案 C");
    const project = projectWith([c, a], {
      baselineId: "a",
      comparisonId: "b",
    });

    const result = reconcileScenarioSelection(project, "remove", "方案 B");

    expect(result.selection).toEqual({ baselineId: "a", comparisonId: "c" });
    expect(result.notice).toContain("已删除对照方案“方案 B”");
  });

  it("deleting the last snapshot empties the pair deterministically", () => {
    const project = projectWith([], {
      baselineId: "a",
      comparisonId: "b",
    });

    const result = reconcileScenarioSelection(project, "remove", "方案 A");

    expect(result.selection).toEqual(EMPTY_SELECTION);
    expect(result.notice).toContain("没有可对比的方案");
  });

  it("deleting an unrelated snapshot leaves the pair untouched", () => {
    const a = snapshot("a", "方案 A");
    const b = snapshot("b", "方案 B");
    const c = snapshot("c", "方案 C");
    const project = projectWith([c, b, a], {
      baselineId: "a",
      comparisonId: "b",
    });

    const result = reconcileScenarioSelection(project, "remove", "方案 C");

    expect(result.changed).toBe(false);
    expect(result.selection).toEqual({ baselineId: "a", comparisonId: "b" });
  });

  it("stale imported selection is repaired and the change is announced", () => {
    const a = snapshot("a", "方案 A");
    const b = snapshot("b", "方案 B");
    const project = projectWith([b, a], {
      baselineId: "ghost-1",
      comparisonId: "ghost-2",
    });

    const result = reconcileScenarioSelection(project, "import");

    expect(result.selection).toEqual({ baselineId: "a", comparisonId: "b" });
    expect(result.notice).toContain("已自动选择");
  });

  it("a valid imported selection survives untouched and stays silent", () => {
    const a = snapshot("a", "方案 A");
    const b = snapshot("b", "方案 B");
    const project = projectWith([b, a], {
      baselineId: "a",
      comparisonId: "b",
    });

    const result = reconcileScenarioSelection(project, "import");

    expect(result.changed).toBe(false);
    expect(result.notice).toBe("");
  });

  it("switching to a project without stored choice initializes its own pair", () => {
    const a = snapshot("a", "方案 A");
    const b = snapshot("b", "方案 B");
    const target = projectWith([b, a], EMPTY_SELECTION);

    const result = reconcileScenarioSelection(target, "switch");

    expect(result.selection).toEqual({ baselineId: "a", comparisonId: "b" });
    expect(result.notice).toContain("该项目此前未指定");
  });

  it("never allows baseline and comparison to be the same snapshot", () => {
    const a = snapshot("a", "方案 A");
    const b = snapshot("b", "方案 B");
    const project = projectWith([b, a], {
      baselineId: "a",
      comparisonId: "b",
    });

    const switched = selectScenarioSide(project, "baselineId", "b");

    expect(switched.project.comparison).toEqual({
      baselineId: "b",
      comparisonId: "a",
    });
    expect(switched.notice).toContain("对照不能与基准相同");
  });

  it("restore does not alter the selection", () => {
    const a = snapshot("a", "方案 A");
    const b = snapshot("b", "方案 B");
    const project: LatencyProject = {
      ...projectWith([b, a], { baselineId: "a", comparisonId: "b" }),
      nodes: [
        {
          id: "node-1",
          name: "请求",
          durationMs: 10,
          jitterMs: 0,
          dependencyIds: [],
          timeoutMs: 1000,
          retryCount: 0,
          failureRate: 0,
        },
      ],
    };

    const result = reconcileScenarioSelection(project, "restore");

    expect(result.changed).toBe(false);
    expect(result.selection).toEqual({ baselineId: "a", comparisonId: "b" });
  });

  it("saveScenario output reconciles to the earliest-versus-newest default", () => {
    const base = projectWith([]);
    const withNodes: LatencyProject = {
      ...base,
      nodes: [
        {
          id: "node-1",
          name: "请求",
          durationMs: 10,
          jitterMs: 0,
          dependencyIds: [],
          timeoutMs: 1000,
          retryCount: 0,
          failureRate: 0,
        },
      ],
    };
    const first = saveScenario(withNodes, simulateProject(withNodes), "第一次");
    expect(reconcileScenarioSelection(first, "save").selection).toEqual(
      EMPTY_SELECTION,
    );
    const second = saveScenario(first, simulateProject(first), "第二次");
    const ids = second.scenarios.map((scenario) => scenario.id);
    expect(reconcileScenarioSelection(second, "save").selection).toEqual({
      baselineId: ids[1],
      comparisonId: ids[0],
    });
  });

  it("duplicating a project starts the copy with no scenarios and an empty selection", () => {
    const a = snapshot("a", "方案 A");
    const source: LatencyProject = {
      id: "source",
      title: "源项目",
      nodes: [],
      concurrencyLimit: null,
      scenarios: [a],
      comparison: { baselineId: "a", comparisonId: "a" },
      createdAt: 1,
      updatedAt: 1,
    };
    const document = {
      version: 1 as const,
      activeProjectId: source.id,
      projects: [source],
    };

    const duplicated = duplicateProject(document, source, 2);
    const copy = duplicated.projects[0]!;

    expect(copy.scenarios).toEqual([]);
    expect(copy.comparison).toEqual(EMPTY_SELECTION);
    expect(copy.id).not.toBe(source.id);
  });
});
