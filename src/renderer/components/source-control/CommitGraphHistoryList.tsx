import type { CommitFileChange, GitGraphRefs, GitLogEntry } from '@shared/types';
import { CommitHistoryList } from './CommitHistoryList';

export interface CommitGraphHistoryListProps {
  commits: GitLogEntry[];
  selectedHash: string | null;
  onCommitClick: (hash: string) => void;
  isLoading?: boolean;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  onLoadMore?: () => void;
  expandedCommitHash?: string | null;
  commitFiles?: CommitFileChange[];
  commitFilesLoading?: boolean;
  selectedFile?: string | null;
  onFileClick?: (filePath: string) => void;
  workdir?: string;
  onRefresh?: () => void;
  graphRefs: GitGraphRefs;
}

/** 图表视图沿用提交操作和文件展开逻辑，但使用独立的图表行布局。 */
export function CommitGraphHistoryList({
  commits,
  graphRefs,
  ...props
}: CommitGraphHistoryListProps) {
  const refColors = new Map<string, number>();
  if (graphRefs.current) refColors.set(graphRefs.current.revision, 0);
  if (graphRefs.remote) refColors.set(graphRefs.remote.revision, 1);
  if (graphRefs.base) refColors.set(graphRefs.base.revision, 2);

  return <CommitHistoryList {...props} commits={commits} graphView graphRefColors={refColors} />;
}
