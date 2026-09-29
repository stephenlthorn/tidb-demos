export type Route =
  | { readonly page: 'catalog' }
  | { readonly page: 'demo'; readonly id: string; readonly relay: string | undefined; readonly t: number | undefined };

const parseStartMs = (query: URLSearchParams): number | undefined => {
  const raw = query.get('t');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

export const parseRoute = (hash: string): Route => {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const id = /^\/demo\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path)?.[1];
  if (id === undefined) return { page: 'catalog' };
  const params = new URLSearchParams(query);
  return { page: 'demo', id, relay: params.get('relay') ?? undefined, t: parseStartMs(params) };
};

export const demoHref = (id: string): string => `#/demo/${id}`;

export const isLocalRelay = (url: string): boolean => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
