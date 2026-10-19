import { describe, expect, it } from 'vitest';
import { chunk, fixtureStatements, generateOrders, insertOrdersSql, orderRowsAsParams } from '../src/fixtureData';

describe('generateOrders', () => {
  it('is deterministic for a seed', () => {
    expect(generateOrders({ seed: 7, count: 50 })).toEqual(generateOrders({ seed: 7, count: 50 }));
  });

  it('differs between seeds', () => {
    expect(generateOrders({ seed: 7, count: 50 })).not.toEqual(generateOrders({ seed: 8, count: 50 }));
  });

  it('numbers rows from one and keeps amounts positive', () => {
    const rows = generateOrders({ seed: 1, count: 20 });
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(rows.every((row) => row.amountCents >= 500)).toBe(true);
  });
});

describe('chunk', () => {
  it('splits into batches with a short last batch', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('orderRowsAsParams', () => {
  it('flattens rows into column order', () => {
    expect(orderRowsAsParams([{ id: 1, customer: 'c', amountCents: 5, status: 'paid' }])).toEqual([[1, 'c', 5, 'paid']]);
  });
});

describe('fixtureStatements', () => {
  it('creates the database and the orders table with quoted identifiers', () => {
    expect(fixtureStatements('fixture')).toEqual([
      'CREATE DATABASE IF NOT EXISTS `fixture`',
      'CREATE TABLE IF NOT EXISTS `fixture`.orders (id INT PRIMARY KEY, customer VARCHAR(40) NOT NULL, amount_cents INT NOT NULL, status VARCHAR(16) NOT NULL)',
    ]);
  });
});

describe('insertOrdersSql', () => {
  it('writes one placeholder tuple per row and ignores rows that already exist', () => {
    expect(insertOrdersSql('fixture', 2)).toBe(
      'INSERT IGNORE INTO `fixture`.orders (id, customer, amount_cents, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    );
  });
});
