import { readFileSync } from 'node:fs';
import type { Body, Course } from '../../../src/types';

export const course: Course = JSON.parse(readFileSync(process.env.COURSE_JSON!, 'utf8'));
export const base = course.basePath.replace(/\/+$/, '');
export const href = (path = '') => `${base}/${path.replace(/^\/+/, '')}`;
export const assetHref = (path: string) => href(`_releases/${course.revision}/${path.replace(/^\/+/, '')}`);
export const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export const chapterForDocument = (id: string) => course.chapters.find(chapter => chapter.documents.includes(id));
export const chapterForSet = (id: string) => course.chapters.find(chapter => chapter.sets.includes(id));
export const firstHeadings = (id: string) => {
  const headings = course.documents[id]?.body.headings || [];
  const level = Math.min(...headings.map(heading => heading.level));
  return headings.filter(heading => heading.level === level);
};

const bodyAnchors = (body: Body) => [...body.html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const problemAnchors = (id: string) => {
  const problem = course.problems[id];
  return [`problem-${id}`, ...bodyAnchors(problem.body), ...[...problem.solutions, ...problem.comments].flatMap(part => [part.id, ...bodyAnchors(part.body)])];
};
// The progress cache may only resume destinations that still exist in this build.
export const readingPages = [
  ...course.chapters.map(chapter => ({ path: href(`chapters/${chapter.id}/`), anchors: ['main-content', 'documents-heading', 'exercises', ...bodyAnchors(chapter.body), ...chapter.problems.flatMap(problemAnchors)] })),
  ...Object.values(course.documents).map(document => ({ path: href(`documents/${document.id}/`), anchors: ['main-content', ...bodyAnchors(document.body)] })),
  ...Object.values(course.sets).map(set => ({ path: href(`sets/${set.id}/`), anchors: ['main-content', 'exercises', ...bodyAnchors(set.body), ...set.problems.flatMap(problemAnchors)] })),
  ...Object.values(course.problems).map(problem => ({ path: href(`problems/${problem.id}/`), anchors: ['main-content', 'exercises', ...problemAnchors(problem.id)] })),
];
