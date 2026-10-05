import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  resolveComparisonSelection,
  selectionAfterRemove,
  selectionAfterSave,
} from "../src/features/scenarios/comparisonSelection";
import type { ScenarioSnapshot } from "../src/shared/domain/types";

function makeScenario(id: string, name = id): ScenarioSnapshot {
  return {
    id,
    name,
    createdAt: 1,
    concurrencyLimit: null,
    nodes: [],
    completionMs: 100,
    criticalPath: [],
  };
}

const a = makeScenario("a", "方案 A");
const b = makeScenario("b", "方案 B");
const c = makeScenario("c", "方案 C");

describe("comparison selection state", () => {
  it("keeps an explicit valid selection unchanged", () => {
    const resolved = resolveComparisonSelection([a, b, c], {
      baselineId: "a",
      comparisonId: "c",
    });
    expect(resolved.status).toBe("ready");
    expect(resolved.selection).toEqual({ baselineId: "a", comparisonId: "c" });
    expect(resolved.notice).toBeUndefined();
  });

  it("never silently swaps to other scenarios when a selected id is gone", () => {
    const resolved = resolveComparisonSelection([b, c], {
      baselineId: "a",
      comparisonId: "b",
    });
    expect(resolved.selection).toEqual({ baselineId: "", comparisonId: "b" });
    expect(resolved.status).toBe("empty");
    expect(resolved.notice).toContain("基准方案");
    expect(resolved.notice).toContain("已不存在");
  });

  it("marks a single remaining scenario instead of faking a pair", () => {
    const resolved = resolveComparisonSelection([a], EMPTY_SELECTION);
    expect(resolved.status).toBe("single");
    expect(resolved.hint).toContain("一份方案");
  });

  it("reports empty status with no scenarios and empty selection", () => {
    const resolved = resolveComparisonSelection([], EMPTY_SELECTION);
    expect(resolved.status).toBe("empty");
  });

  it("flags the same scenario chosen on both sides", () => {
    const resolved = resolveComparisonSelection([a, b], {
      baselineId: "a",
      comparisonId: "a",
    });
    expect(resolved.status).toBe("same");
    expect(resolved.hint).toContain("同一份方案");
  });

  it("preselects newest pair only when the user has never chosen, on second save", () => {
    // 新快照插到列表头部：[最新, 次新]
    const first = selectionAfterSave([a], EMPTY_SELECTION);
    expect(first.selection).toEqual(EMPTY_SELECTION);

    const second = selectionAfterSave([b, a], EMPTY_SELECTION);
    expect(second.selection).toEqual({ baselineId: "a", comparisonId: "b" });
    expect(second.notice).toContain("方案 A");
    expect(second.notice).toContain("方案 B");
  });

  it("does not override an existing explicit selection on save", () => {
    const migrated = selectionAfterSave([c, a, b], {
      baselineId: "a",
      comparisonId: "b",
    });
    expect(migrated.selection).toEqual({ baselineId: "a", comparisonId: "b" });
    expect(migrated.notice).toBe("");
  });

  it("replaces the removed side with another remaining scenario and explains it", () => {
    const migrated = selectionAfterRemove(
      [b, c],
      { baselineId: "a", comparisonId: "b" },
      a,
    );
    // 基准侧被删，补位不能抢占对照侧 b
    expect(migrated.selection.comparisonId).toBe("b");
    expect(["c"]).toContain(migrated.selection.baselineId);
    expect(migrated.notice).toContain("方案 A");
    expect(migrated.notice).toContain("基准方案");
  });

  it("leaves the untouched side intact when the other side is removed", () => {
    const migrated = selectionAfterRemove(
      [a, c],
      { baselineId: "a", comparisonId: "b" },
      b,
    );
    expect(migrated.selection.baselineId).toBe("a");
    expect(migrated.selection.comparisonId).toBe("c");
  });

  it("drops to empty when the deletion leaves a single scenario", () => {
    const migrated = selectionAfterRemove(
      [b],
      { baselineId: "a", comparisonId: "b" },
      a,
    );
    expect(migrated.selection).toEqual({ baselineId: "", comparisonId: "b" });
    expect(migrated.notice).toContain("只剩一份方案");
  });

  it("rebuilds a pair when the same scenario filled both sides and is removed", () => {
    const migrated = selectionAfterRemove([b, c], {
      baselineId: "a",
      comparisonId: "a",
    }, a);
    expect(migrated.selection).toEqual({ baselineId: "b", comparisonId: "c" });
    expect(migrated.notice).toContain("已删除");
  });

  it("clears both sides when the shared scenario is removed and one remains", () => {
    const migrated = selectionAfterRemove([b], {
      baselineId: "a",
      comparisonId: "a",
    }, a);
    expect(migrated.selection).toEqual(EMPTY_SELECTION);
    expect(migrated.notice).toContain("只剩一份方案");
  });

  it("does nothing when removing a scenario not part of the selection", () => {
    const migrated = selectionAfterRemove(
      [a, b],
      { baselineId: "a", comparisonId: "b" },
      c,
    );
    expect(migrated.selection).toEqual({ baselineId: "a", comparisonId: "b" });
    expect(migrated.notice).toBe("");
  });
});
