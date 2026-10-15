/** Supported mathematical prose blocks. Numbered blocks share a chapter counter. */
export const semanticBlocks = {
  theorem: { label: '定理', numbered: true },
  definition: { label: '定义', numbered: true },
  proposition: { label: '命题', numbered: true },
  lemma: { label: '引理', numbered: true },
  corollary: { label: '推论', numbered: true },
  remark: { label: '注', numbered: true },
  note: { label: '注', numbered: true },
  example: { label: '例', numbered: true },
  exercise: { label: '练习', numbered: true },
  warning: { label: '警示', numbered: true },
  proof: { label: '证明', numbered: false },
} as const;

export type SemanticKind = keyof typeof semanticBlocks;

export function semanticBlock(kind: string): typeof semanticBlocks[SemanticKind] | undefined {
  return Object.hasOwn(semanticBlocks, kind) ? semanticBlocks[kind as SemanticKind] : undefined;
}

export function semanticHeading(label: string, number?: string, title?: string): string {
  return `${label}${number ? ` ${number}` : ''}${title ? `（${title}）` : ''}`;
}
