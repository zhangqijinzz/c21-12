export interface RequestNode {
  id: string;
  name: string;
  durationMs: number;
  jitterMs: number;
  dependencyIds: string[];
  timeoutMs: number;
  retryCount: number;
  failureRate: number;
  fallbackNodeId?: string;
}

export interface ScenarioSnapshot {
  id: string;
  name: string;
  createdAt: number;
  concurrencyLimit: number | null;
  nodes: RequestNode[];
  completionMs: number;
  criticalPath: string[];
}

/**
 * 方案对比是一项明确状态：基准方案与对照方案的 ID。
 * 空字符串代表该侧未选择；同一项目内的两侧必须指向不同的快照。
 */
export interface ComparisonSelection {
  baselineId: string;
  comparisonId: string;
}

export const EMPTY_SELECTION: ComparisonSelection = {
  baselineId: "",
  comparisonId: "",
};

export interface LatencyProject {
  id: string;
  title: string;
  nodes: RequestNode[];
  concurrencyLimit: number | null;
  scenarios: ScenarioSnapshot[];
  comparison: ComparisonSelection;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceDocument {
  version: 1;
  activeProjectId: string;
  projects: LatencyProject[];
}

export type SimulationMode = "low" | "expected" | "high";

export interface TimelineEntry {
  nodeId: string;
  startMs: number;
  endMs: number;
  modeledDurationMs: number;
  waitMs: number;
  criticalPredecessorId?: string;
}

export interface SimulationResult {
  mode: SimulationMode;
  completionMs: number;
  criticalPath: string[];
  entries: TimelineEntry[];
  warnings: string[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export const EXAMPLE_PROJECT: LatencyProject = {
  id: "project-latency-demo",
  title: "商品详情页 · 首屏预算",
  concurrencyLimit: null,
  createdAt: 1_728_000_000_000,
  updatedAt: 1_728_000_000_000,
  scenarios: [],
  comparison: { baselineId: "", comparisonId: "" },
  nodes: [
    {
      id: "session",
      name: "会话校验",
      durationMs: 280,
      jitterMs: 80,
      dependencyIds: [],
      timeoutMs: 800,
      retryCount: 1,
      failureRate: 1,
    },
    {
      id: "flags",
      name: "功能开关",
      durationMs: 210,
      jitterMs: 50,
      dependencyIds: [],
      timeoutMs: 700,
      retryCount: 0,
      failureRate: 0,
    },
    {
      id: "profile",
      name: "用户资料",
      durationMs: 460,
      jitterMs: 120,
      dependencyIds: ["session"],
      timeoutMs: 1200,
      retryCount: 1,
      failureRate: 3,
    },
    {
      id: "catalog",
      name: "商品目录",
      durationMs: 740,
      jitterMs: 180,
      dependencyIds: ["session"],
      timeoutMs: 1400,
      retryCount: 1,
      failureRate: 2,
    },
    {
      id: "recommend",
      name: "个性推荐",
      durationMs: 520,
      jitterMs: 220,
      dependencyIds: ["flags", "profile"],
      timeoutMs: 1500,
      retryCount: 1,
      failureRate: 5,
      fallbackNodeId: "catalog",
    },
  ],
};

export function createEmptyProject(now = Date.now()): LatencyProject {
  return {
    id: `project-${crypto.randomUUID()}`,
    title: "未命名链路",
    nodes: [],
    concurrencyLimit: null,
    scenarios: [],
    comparison: { baselineId: "", comparisonId: "" },
    createdAt: now,
    updatedAt: now,
  };
}
