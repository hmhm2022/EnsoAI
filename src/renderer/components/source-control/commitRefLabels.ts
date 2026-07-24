export type CommitRefKind = 'head' | 'local' | 'remote' | 'tag';

export interface CommitRefLabel {
  name: string;
  kind: CommitRefKind;
}

export function parseCommitRefs(refs?: string): CommitRefLabel[] {
  if (!refs) return [];

  return refs
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => {
      if (ref.startsWith('HEAD ->')) {
        return { name: ref.slice('HEAD ->'.length).trim(), kind: 'head' as const };
      }
      if (ref.startsWith('tag:')) {
        return { name: ref.slice('tag:'.length).trim(), kind: 'tag' as const };
      }
      if (ref.startsWith('origin/') || ref.startsWith('remotes/')) {
        return { name: ref.replace(/^remotes\//, ''), kind: 'remote' as const };
      }
      return { name: ref, kind: 'local' as const };
    });
}
