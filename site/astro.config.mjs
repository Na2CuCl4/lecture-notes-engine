import { defineConfig } from 'astro/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (!process.env.COURSE_JSON) throw new Error('COURSE_JSON is required. Use the project build command.');
const course = JSON.parse(readFileSync(process.env.COURSE_JSON, 'utf8'));
const assetPrefix = `${course.basePath.replace(/\/+$/, '')}/_releases/${course.revision}`;
export default defineConfig({
  output: 'static',
  base: course.basePath || '/',
  site: course.siteUrl || undefined,
  trailingSlash: 'always',
  outDir: resolve(process.env.SITE_OUTPUT_DIR || '../dist/site'),
  cacheDir: resolve(process.env.ASTRO_CACHE_DIR || `${tmpdir()}/lecture-notes-astro`),
  build: { format: 'directory', inlineStylesheets: 'never', assetsPrefix: assetPrefix },
  vite: { cacheDir: resolve(process.env.ASTRO_CACHE_DIR || `${tmpdir()}/lecture-notes-astro`), build: { sourcemap: false } },
});
