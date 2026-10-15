export interface SearchProblem {
  id: string; chapterId: string; tags: string[]; sources: string[]; difficulty: number | null; hasSolutions: boolean; text: string;
}
export interface Filters { search: string; tag: string; source: string; difficulty: string; solutions: string }
export function filterProblems(problems: SearchProblem[], filters: Filters): SearchProblem[] {
  const words = filters.search.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return problems.filter(problem => {
    if (filters.tag && !problem.tags.includes(filters.tag)) return false;
    if (filters.source && !problem.sources.includes(filters.source)) return false;
    if (filters.difficulty === 'unrated' && problem.difficulty !== null) return false;
    if (filters.difficulty && filters.difficulty !== 'unrated' && problem.difficulty !== Number(filters.difficulty)) return false;
    if (filters.solutions === 'yes' && !problem.hasSolutions) return false;
    if (filters.solutions === 'no' && problem.hasSolutions) return false;
    const text = problem.text.normalize('NFKC').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}
export function restoreSelection(ids: string[], problems: SearchProblem[]) {
  const allowed = new Set(problems.map(problem => problem.id));
  const seen = new Set<string>();
  return ids.filter(id => allowed.has(id) && !seen.has(id) && Boolean(seen.add(id)));
}
export function groupByChapter(ids: string[], problems: SearchProblem[]) {
  const byId = new Map(problems.map(problem => [problem.id, problem]));
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const problem = byId.get(id);
    if (!problem) continue;
    const group = groups.get(problem.chapterId) || [];
    group.push(id);
    groups.set(problem.chapterId, group);
  }
  return groups;
}
export function randomSample<T>(values: T[], count: number, randomInteger: (exclusiveMax: number) => number): T[] {
  const sample = [...values];
  const size = Math.max(0, Math.min(sample.length, Math.trunc(count)));
  for (let i = 0; i < size; i++) {
    const j = i + randomInteger(sample.length - i);
    [sample[i], sample[j]] = [sample[j], sample[i]];
  }
  return sample.slice(0, size);
}
