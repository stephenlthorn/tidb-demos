const fnv1a = (text: string): number =>
  [...text].reduce((hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0, 2166136261);

export const hashEmbedding = (text: string, dimensions = 64): readonly number[] => {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slots = tokens.map((token) => fnv1a(token) % dimensions);
  const counts = Array.from({ length: dimensions }, (_, slot) => slots.filter((candidate) => candidate === slot).length);
  const norm = Math.sqrt(counts.reduce((sum, count) => sum + count * count, 0));
  if (norm === 0) return counts;
  return counts.map((count) => Math.round((count / norm) * 1e6) / 1e6);
};

export const vectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`;
