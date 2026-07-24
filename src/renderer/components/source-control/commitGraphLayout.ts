export interface GraphCommit {
  hash: string;
  parents: string[];
}

export type GraphSegmentKind = 'straight' | 'branch' | 'merge' | 'dangling';

export interface GraphSegment {
  fromColumn: number;
  toColumn: number;
  kind: GraphSegmentKind;
}

export interface GraphLane {
  hash: string;
  color: number;
}

export interface GraphRow {
  hash: string;
  parents: string[];
  column: number;
  circleColor: number;
  inputLanes: GraphLane[];
  outputLanes: GraphLane[];
  activeColumns: string[];
  lanes: Array<GraphLane | null>;
  segments: GraphSegment[];
}

/**
 * 按 VS Code 的输入/输出线路思路计算每一行。
 * 引用颜色会覆盖当前线路颜色，并沿第一个父提交继续传递。
 */
export function buildCommitGraphLayout(
  commits: GraphCommit[],
  refColors: ReadonlyMap<string, number> = new Map()
): GraphRow[] {
  // 开发时主进程和页面可能短暂处于不同版本，旧日志数据没有 parents。
  // 统一按空数组处理，避免切换到图表时整个页面白屏。
  const normalizedCommits = commits.map((commit) => ({
    ...commit,
    parents: Array.isArray(commit.parents) ? commit.parents : [],
  }));
  const knownHashes = new Set(normalizedCommits.map((commit) => commit.hash));
  const rows: GraphRow[] = [];
  let activeLanes: GraphLane[] = [];
  let nextExtraColor = 3;

  const allocateExtraColor = () => {
    const color = nextExtraColor;
    nextExtraColor = nextExtraColor >= 7 ? 3 : nextExtraColor + 1;
    return color;
  };

  for (const commit of normalizedCommits) {
    const inputLanes = activeLanes.map((lane) => ({ ...lane }));
    const inputIndex = inputLanes.findIndex((lane) => lane.hash === commit.hash);
    const column = inputIndex >= 0 ? inputIndex : inputLanes.length;
    const inheritedColor =
      inputIndex >= 0
        ? inputLanes[inputIndex].color
        : (refColors.get(commit.hash) ?? allocateExtraColor());
    const circleColor = refColors.get(commit.hash) ?? inheritedColor;
    const outputLanes: GraphLane[] = [];
    let firstParentAdded = false;

    for (const lane of inputLanes) {
      if (lane.hash !== commit.hash) {
        outputLanes.push({ ...lane });
        continue;
      }

      if (commit.parents[0] && !firstParentAdded) {
        outputLanes.push({ hash: commit.parents[0], color: circleColor });
        firstParentAdded = true;
      }
    }

    if (inputIndex < 0 && commit.parents[0]) {
      outputLanes.push({ hash: commit.parents[0], color: circleColor });
      firstParentAdded = true;
    }

    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
      const parent = commit.parents[index];
      if (outputLanes.some((lane) => lane.hash === parent)) continue;
      outputLanes.push({
        hash: parent,
        color: refColors.get(parent) ?? allocateExtraColor(),
      });
    }

    // 同一祖先可以同时出现在两条活动线路中，直到它自己的提交行才汇合。
    // 提前去重会让真实的合并关系少掉一条线。
    activeLanes = outputLanes;

    const segments = commit.parents.flatMap((parent, parentIndex) => {
      const parentColumn =
        parentIndex === 0 ? column : activeLanes.map((lane) => lane.hash).lastIndexOf(parent);
      if (parentColumn < 0) return [];
      return [
        {
          fromColumn: column,
          toColumn: parentColumn,
          kind: !knownHashes.has(parent)
            ? ('dangling' as const)
            : parentColumn === column
              ? ('straight' as const)
              : parentIndex > 0
                ? ('merge' as const)
                : ('branch' as const),
        },
      ];
    });

    rows.push({
      hash: commit.hash,
      parents: commit.parents,
      column,
      circleColor,
      inputLanes,
      outputLanes: activeLanes.map((lane) => ({ ...lane })),
      activeColumns: activeLanes.map((lane) => lane.hash),
      lanes: activeLanes.map((lane) => ({ ...lane })),
      segments,
    });
  }

  return rows;
}
