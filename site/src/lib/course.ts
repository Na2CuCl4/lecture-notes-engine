import { readFileSync } from 'node:fs';
import type { Course } from '../../../src/types';

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
