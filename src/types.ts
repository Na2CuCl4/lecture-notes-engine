export type PandocNode = { t: string; c?: any };
export type PandocDocument = { 'pandoc-api-version': number[]; meta: Record<string, any>; blocks: PandocNode[] };
export interface Heading { id: string; text: string; level: number }
export interface Body { ast: PandocDocument; html: string; text: string; headings: Heading[]; source: string }
export interface Part { id: string; title: string; kind?: string; body: Body }
export interface Document { id: string; title: string; tags: string[]; body: Body }
export interface Problem { id: string; title: string; tags: string[]; sources: string[]; difficulty: number | null; chapterId: string; number: string; body: Body; solutions: Part[]; comments: Part[] }
export interface ExerciseSet { id: string; title: string; body: Body; problems: string[]; groups?: { title: string; problems: string[] }[] }
export interface Chapter { id: string; title: string; number: number; body: Body; documents: string[]; problems: string[]; sets: string[] }
export interface Reference { id: string; title: string; label: string; url: string; ownerId: string; chapterId?: string; kind: 'chapter' | 'document' | 'problem' | 'set' | 'heading' | 'equation' | 'figure' | 'semantic' }
export interface Course {
  schemaVersion: 1; engineVersion: string; revision: string; builtAt: string;
  title: string; subtitle?: string; author: string; language: string; basePath: string; siteUrl: string;
  chapters: Chapter[]; documents: Record<string, Document>; problems: Record<string, Problem>; sets: Record<string, ExerciseSet>;
  references: Record<string, Reference>; macros: string; macroConfig: Record<string, string | [string, number]>;
  assets: { source: string; path: string; digest: string }[];
}
export type SolutionMode = 'none' | 'inline' | 'end';
export interface PrintRequest { revision: string; chapterId: string; problemIds: string[]; includeDocuments: boolean; solutions: SolutionMode; comments: boolean; title?: string }
export interface BookRequest { revision: string; kind: 'book'; solutions: SolutionMode; comments: boolean }
export type CompileRequest = PrintRequest | BookRequest;
export interface PrintJob { id: string; key: string; request: CompileRequest; state: 'queued' | 'running' | 'succeeded' | 'failed'; createdAt: string; updatedAt: string; attempts: number; error?: string; outputPath?: string; position?: number }
