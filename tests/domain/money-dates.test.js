import { describe, it, expect } from 'vitest';
import { parseMoney, formatMoney, roundDiv, mulDiv, allocateCents, monthlyInterest, applyBps, isValidCents, MAX_CENTS, parsePercentToBps, formatBps, centsToDecimalString } from '../../src/domain/money.js';
import { isValidDate, addDays, addMonths, daysInMonth, isLeapYear, diffDays, weekday, adjustBusinessDay, monthRange, addMonthKey, monthEnd, formatDate, formatMonth } from '../../src/domain/dates.js';

describe('money: exact cents', () => {
  it('parses decimal strings without floating point drift', () => {
    expect(parseMoney('0.10')).toEqual({ ok: true, cents: 10 });
    expect(parseMoney('0.20').cents + parseMoney('0.10').cents).toBe(parseMoney('0.30').cents);
    expect(parseMoney('1,234.56').cents).toBe(123456);
    expect(parseMoney('$ 12').cents).toBe(1200);
    expect(parseMoney('-47.35').cents).toBe(-4735);
    expect(parseMoney('(45.00)').cents).toBe(-4500);
    expect(parseMoney('45.00-').cents).toBe(-4500);
    expect(parseMoney('19.995').ok).toBe(false); // would need silent rounding
    expect(parseMoney('1.230').cents).toBe(123); // trailing zeros are fine
    expect(parseMoney('1.234,56', { decimal: ',' }).cents).toBe(123456);
  });
  it('rejects malformed and out-of-range input', () => {
    for (const bad of ['', 'abc', '1.2.3', '12,34,5', NaN, Infinity, '9999999999999', '1e5', null, undefined]) {
      expect(parseMoney(bad).ok, String(bad)).toBe(false);
    }
    expect(parseMoney('1000000000.01').ok).toBe(false);
    expect(parseMoney('1000000000.00').ok).toBe(true);
  });
  it('validates integer cents', () => {
    expect(isValidCents(100)).toBe(true);
    expect(isValidCents(10.5)).toBe(false);
    expect(isValidCents(NaN)).toBe(false);
    expect(isValidCents(Infinity)).toBe(false);
    expect(isValidCents(MAX_CENTS + 1)).toBe(false);
    expect(isValidCents(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isValidCents('100')).toBe(false);
  });
  it('rounds half away from zero, consistently', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(4, 2)).toBe(2);
    expect(roundDiv(1, 3)).toBe(0);
    expect(roundDiv(2, 3)).toBe(1);
    expect(mulDiv(1999, 1, 12)).toBe(167);
    expect(applyBps(10000, 1999)).toBe(1999);
  });
  it('computes monthly interest deterministically', () => {
    expect(monthlyInterest(100000, 1200)).toBe(1000); // 12% APR on $1,000 -> $10.00
    expect(monthlyInterest(123456, 2299)).toBe(monthlyInterest(123456, 2299));
    expect(monthlyInterest(5000, 0)).toBe(0);
    expect(monthlyInterest(0, 1999)).toBe(0);
    expect(monthlyInterest(1, 1)).toBe(0);
  });
  it('allocates cents without losing or creating pennies', () => {
    for (const total of [100, 101, 1, 0, -100, -101, 9999]) {
      for (const w of [[1, 1, 1], [3, 2, 1], [1], [0, 5], [7, 7, 7, 7]]) {
        const parts = allocateCents(total, w);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });
  it('formats money safely', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(-5)).toBe('-$0.05');
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(NaN)).toBe('$0.00');
    expect(formatMoney(100, { signed: true })).toBe('+$1.00');
    expect(formatMoney(-100, { parens: true })).toBe('($1.00)');
    expect(centsToDecimalString(-1234)).toBe('-12.34');
  });
  it('parses percentages to basis points', () => {
    expect(parsePercentToBps('19.99')).toEqual({ ok: true, bps: 1999 });
    expect(parsePercentToBps('5%').bps).toBe(500);
    expect(parsePercentToBps('abc').ok).toBe(false);
    expect(formatBps(1999)).toBe('19.99%');
  });
});

describe('dates: calendar-date semantics', () => {
  it('validates real calendar dates only', () => {
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2100-02-29')).toBe(false);
    expect(isValidDate('2000-02-29')).toBe(true);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-1-1')).toBe(false);
    expect(isValidDate('not a date')).toBe(false);
    expect(isValidDate(20260101)).toBe(false);
    expect(isLeapYear(2024)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
  });
  it('does arithmetic without time-zone drift', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // DST change day in the US
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
    expect(weekday('2026-10-01')).toBe(4); // Thursday
  });
  it('adds months with an anchor day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2024-02-29', 48)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });
  it('handles month keys across years', () => {
    expect(addMonthKey('2025-12', 1)).toBe('2026-01');
    expect(addMonthKey('2026-01', -1)).toBe('2025-12');
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthRange('2026-02', '2026-01')).toEqual([]);
    expect(monthEnd('2024-02')).toBe('2024-02-29');
  });
  it('moves weekend dates to business days', () => {
    expect(adjustBusinessDay('2026-10-03', 'next')).toBe('2026-10-05'); // Saturday
    expect(adjustBusinessDay('2026-10-04', 'prev')).toBe('2026-10-02'); // Sunday
    expect(adjustBusinessDay('2026-10-02', 'next')).toBe('2026-10-02');
    expect(adjustBusinessDay('2026-10-03', 'none')).toBe('2026-10-03');
  });
  it('formats without timezone shifts', () => {
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatMonth('2025-12')).toBe('December 2025');
  });
});
