import { createHash } from 'node:crypto';

export type Tree = Readonly<Record<string, string>>;

export const treeHash = (tree: Tree): string => {
  const hash = createHash('sha256');
  Object.keys(tree)
    .sort()
    .forEach((path) => {
      hash.update(`${path}\0${tree[path] ?? ''}\0`);
    });
  return hash.digest('hex');
};

export const changedPaths = (base: Tree, current: Tree): readonly string[] =>
  [...new Set([...Object.keys(base), ...Object.keys(current)])].filter((path) => base[path] !== current[path]).sort();

export const stripPrefix = (path: string, prefix: string): string => {
  const normalised = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalised) ? path.slice(normalised.length) : path;
};
