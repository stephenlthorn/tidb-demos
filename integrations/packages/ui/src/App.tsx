import { useEffect, useState } from 'react';
import { AppBar } from './components/AppBar';
import { fetchCatalog, fetchTrace } from './data';
import { CatalogPage } from './pages/CatalogPage';
import { LivePage } from './pages/LivePage';
import { ReplayPage } from './pages/ReplayPage';
import { isLocalRelay, parseRoute } from './route';

const useHash = (): string => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
};

const Page = ({ route }: { readonly route: ReturnType<typeof parseRoute> }) => {
  if (route.page === 'catalog') return <CatalogPage load={fetchCatalog} />;
  if (route.relay !== undefined && isLocalRelay(route.relay)) return <LivePage key={route.relay} relayUrl={route.relay} />;
  return <ReplayPage key={route.id} id={route.id} load={fetchTrace} initialPositionMs={route.t} />;
};

export const App = () => {
  const route = parseRoute(useHash());
  return (
    <>
      <AppBar showHome={route.page !== 'catalog'} />
      <Page route={route} />
    </>
  );
};
