import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterProblems, restoreSelection, groupByChapter, randomSample, paginateProblems, pageForAnchor, paginationNumbers, type SearchProblem } from '../site/src/scripts/list-state.js';
import { readingHref, restoreReadingProgress, type ReadingPage } from '../site/src/scripts/reading-state.js';

const problems: SearchProblem[] = [
  { id: 'a', chapterId: 'one', tags: ['极限'], sources: ['教材'], difficulty: 2, hasSolutions: true, text: '极限 SUP 与证明' },
  { id: 'b', chapterId: 'two', tags: ['连续'], sources: ['试卷'], difficulty: null, hasSolutions: false, text: '连续函数的反例' },
  { id: 'c', chapterId: 'one', tags: ['极限'], sources: ['试卷'], difficulty: 4, hasSolutions: true, text: '极限的反例' },
];
const empty = { search: '', tag: '', source: '', difficulty: '', solutions: '' };
test('filters combine metadata and normalized full-text words', () => {
  assert.deepEqual(filterProblems(problems, { ...empty, search: '极限 ｓｕｐ', tag: '极限', source: '教材', difficulty: '2', solutions: 'yes' }).map(problem => problem.id), ['a']);
  assert.deepEqual(filterProblems(problems, { ...empty, difficulty: 'unrated', solutions: 'no' }).map(problem => problem.id), ['b']);
  assert.deepEqual(filterProblems(problems, { ...empty, tag: '连续', solutions: 'yes' }), []);
});
test('shared selection preserves actual order and rejects missing or duplicate IDs', () => {
  assert.deepEqual(restoreSelection(['c', 'unknown', 'a', 'c'], problems), ['c', 'a']);
});
test('cross-chapter print jobs keep the displayed order within each chapter', () => {
  assert.deepEqual([...groupByChapter(['c', 'b', 'a'], problems)], [['one', ['c', 'a']], ['two', ['b']]]);
});
test('sampling is bounded, without replacement and leaves source ordering untouched', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(randomSample(ids, 2, max => max - 1), ['c', 'a']);
  assert.equal(new Set(randomSample(ids, 20, () => 0)).size, 3);
  assert.deepEqual(randomSample(ids, 0, () => 0), []);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

const manyProblems: SearchProblem[] = Array.from({ length: 25 }, (_, index) => ({
  id: `p${index + 1}`, chapterId: index < 17 ? 'one' : 'two', tags: [index % 2 ? '连续' : '极限'], sources: [], difficulty: 2, hasSolutions: true, text: `problem ${index + 1}`,
  anchors: [`problem-p${index + 1}`, `solution-p${index + 1}`, `equation-p${index + 1}`],
}));
const manyIds = manyProblems.map(problem => problem.id);
test('pagination renders at most ten problems and clamps invalid pages', () => {
  assert.deepEqual(paginateProblems(manyIds, '2'), { page: 2, pages: 3, ids: manyIds.slice(10, 20), total: 25 });
  assert.deepEqual(paginateProblems(manyIds, 999).ids, manyIds.slice(20));
  for (const value of [-5, NaN, Infinity, 'broken', undefined]) assert.equal(paginateProblems(manyIds, value).page, 1);
  assert.deepEqual(paginateProblems([], 9), { page: 1, pages: 1, ids: [], total: 0 });
  assert.equal(paginateProblems(manyIds.slice(0, 10), 1).pages, 1);
  assert.equal(paginateProblems(manyIds.slice(0, 11), 2).ids.length, 1);
});
test('deep links choose the page containing a problem, solution, or formula', () => {
  assert.equal(pageForAnchor(manyIds, manyProblems, 'problem-p11'), 2);
  assert.equal(pageForAnchor(manyIds, manyProblems, 'solution-p25'), 3);
  assert.equal(pageForAnchor(manyIds, manyProblems, 'equation-p20'), 2);
  assert.equal(pageForAnchor(manyIds.slice(0, 10), manyProblems, 'solution-p25'), null);
  assert.equal(pageForAnchor(manyIds, manyProblems, 'exercises'), null);
  const selected = [...manyIds].reverse();
  assert.equal(pageForAnchor(selected, manyProblems, 'solution-p1'), 3);
  assert.equal(pageForAnchor(selected, manyProblems, 'solution-p25'), 1);
});
test('filters and random selections paginate independently without truncating print/share IDs', () => {
  const filteredIds = filterProblems(manyProblems, { ...empty, tag: '极限' }).map(problem => problem.id);
  assert.equal(filteredIds.length, 13);
  assert.equal(paginateProblems(filteredIds, 1).ids.length, 10);
  assert.equal(paginateProblems(filteredIds, 2).ids.length, 3);
  const selected = restoreSelection(randomSample(manyIds, 23, () => 0), manyProblems);
  const before = [...selected];
  assert.equal(paginateProblems(selected, 3).ids.length, 3);
  assert.deepEqual(selected, before);
  assert.equal([...groupByChapter(selected, manyProblems).values()].flat().length, 23);
});
test('large collections retain bounded page controls with ellipses', () => {
  assert.deepEqual(paginationNumbers(1, 3), [1, 2, 3]);
  assert.deepEqual(paginationNumbers(50, 100), [1, 'gap', 48, 49, 50, 51, 52, 'gap', 100]);
  assert.deepEqual(paginationNumbers(1, 100), [1, 2, 3, 'gap', 100]);
});

const readingPages: ReadingPage[] = [
  { path: '/course/chapters/limits/', anchors: ['exercises', 'problem-limit', 'solution-direct'] },
  { path: '/course/documents/numbers/', anchors: ['real-numbers'] },
];
test('reading progress accepts only existing course pages and anchors on this origin', () => {
  const origin = 'https://notes.example';
  assert.equal(readingHref('/course/documents/numbers/#real-numbers', origin, readingPages), '/course/documents/numbers/#real-numbers');
  for (const href of ['https://elsewhere.example/course/chapters/limits/', '/other/chapters/limits/', '/course/chapters/deleted/', '/course/chapters/limits/#deleted', '/course/', 'javascript:alert(1)']) {
    assert.equal(readingHref(href, origin, readingPages), null, href);
  }
});
test('course updates preserve valid reading positions and selected problem links', () => {
  const saved = { href: '/course/chapters/limits/?problems=limit&revision=old#exercises', revision: 'old', timestamp: 1234, scrollY: 945, anchor: 'problem-limit', offset: -85, expanded: ['solution-direct', 'deleted-solution'] };
  const restored = restoreReadingProgress(saved, 'https://notes.example', readingPages, 'new');
  assert.deepEqual(restored, { ...saved, href: '/course/chapters/limits/?problems=limit&revision=new#exercises', revision: 'new', expanded: ['solution-direct'] });
  assert.equal(restoreReadingProgress({ ...saved, href: '/course/chapters/deleted/' }, 'https://notes.example', readingPages, 'new'), null);
});
test('resuming a paginated selection preserves page, filters, hash, and a newer valid revision', () => {
  const href = '/course/chapters/limits/?page=3&tag=%E6%9E%81%E9%99%90&problems=p25%2Cp11%2Cp1&revision=old#solution-direct';
  const restored = restoreReadingProgress({ href, revision: 'old', timestamp: 1, scrollY: 500, anchor: 'solution-direct' }, 'https://notes.example', readingPages, 'new')!;
  const url = new URL(restored.href, 'https://notes.example');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('problems'), 'p25,p11,p1');
  assert.equal(url.searchParams.get('tag'), '极限');
  assert.equal(url.searchParams.get('revision'), 'new');
  assert.equal(url.hash, '#solution-direct');
});
test('malformed reading caches fail safely and removed optional anchors use the saved scroll position', () => {
  for (const value of [null, [], {}, { href: '/course/chapters/limits/', revision: 'old', timestamp: NaN }]) {
    assert.equal(restoreReadingProgress(value, 'https://notes.example', readingPages, 'new'), null);
  }
  assert.deepEqual(restoreReadingProgress({ href: '/course/documents/numbers/', revision: 'old', timestamp: 1, scrollY: 400, anchor: 'removed-heading', offset: 30, expanded: 'bad' }, 'https://notes.example', readingPages, 'new'), {
    href: '/course/documents/numbers/', revision: 'new', timestamp: 1, scrollY: 400, expanded: [],
  });
});
