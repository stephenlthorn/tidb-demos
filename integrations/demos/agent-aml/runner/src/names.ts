export const tokenizeName = (name: string): readonly string[] =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 1);

const levenshtein = (a: string, b: string): number => {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const final = [...a].reduce<readonly number[]>(
    (row, charA, i) =>
      [...b].reduce<readonly number[]>(
        (next, charB, j) => {
          const left = next[j] ?? 0;
          const diagonal = row[j] ?? 0;
          const above = row[j + 1] ?? 0;
          return [...next, Math.min(left + 1, above + 1, diagonal + (charA === charB ? 0 : 1))];
        },
        [i + 1],
      ),
    previous,
  );
  return final[b.length] ?? 0;
};

const tokenSimilarity = (a: string, b: string): number => {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
};

const bestMatch = (token: string, candidates: readonly string[]): number =>
  candidates.reduce((best, candidate) => Math.max(best, tokenSimilarity(token, candidate)), 0);

export const nameSimilarity = (a: string, b: string): number => {
  const tokensA = tokenizeName(a);
  const tokensB = tokenizeName(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const total = shorter.reduce((sum, token) => sum + bestMatch(token, longer), 0);
  return total / shorter.length;
};

export const ftsQueryFromName = (name: string): string => tokenizeName(name).join(' ');

export const sharesToken = (a: string, b: string): boolean => {
  const tokensB = new Set(tokenizeName(b));
  return tokenizeName(a).some((token) => tokensB.has(token));
};
