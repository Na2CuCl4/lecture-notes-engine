import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterProblems, restoreSelection, groupByChapter, randomSample, type SearchProblem } from '../site/src/scripts/list-state.js';

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
