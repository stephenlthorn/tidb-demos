export type Route =
  | { readonly page: 'catalog' }
  | { readonly page: 'demo'; readonly id: string; readonly relay: string | undefined };

export const parseRoute = (hash: string): Route => {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const id = /^\/demo\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path)?.[1];
  if (id === undefined) return { page: 'catalog' };
  return { page: 'demo', id, relay: new URLSearchParams(query).get('relay') ?? undefined };
};

export const demoHref = (id: string): string => `#/demo/${id}`;

export const isLocalRelay = (url: string): boolean => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
