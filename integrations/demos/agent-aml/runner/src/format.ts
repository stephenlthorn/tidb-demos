export const formatCents = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, '0');
  return `${sign}$${dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${remainder}`;
};

export const percentText = (ratio: number | undefined): string =>
  ratio === undefined ? 'n/a' : `${(ratio * 100).toFixed(1)}%`;
