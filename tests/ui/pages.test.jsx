import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from './helpers.jsx';

const ROUTES = [
  ['/', /Dashboard/],
  ['/accounts', /Accounts/],
  ['/accounts/acct-chk-main', /Harbor Everyday Checking/],
  ['/accounts/acct-cc-rewards?tab=details', /Meridian Rewards Visa/],
  ['/accounts/acct-cc-rewards?tab=reconciliation', /Meridian Rewards Visa/],
  ['/transactions', /Transactions/],
  ['/transactions/rules', /Rules & categories/],
  ['/import', /Import CSV transactions/],
  ['/import/reconcile', /Reconcile a statement/],
  ['/import/history', /Import & reconciliation history/],
  ['/budgets', /Budgets/],
  ['/budgets?view=year', /Budgets/],
  ['/budgets/cat-groceries', /Groceries budget/],
  ['/recurring', /Recurring & bills/],
  ['/recurring?tab=rules', /Recurring & bills/],
  ['/recurring?tab=subs', /Recurring & bills/],
  ['/goals', /Savings goals/],
  ['/goals/debt', /Debt & payoff/],
  ['/reports/cashflow', /Reports & analytics/],
  ['/reports/categories', /Reports & analytics/],
  ['/reports/networth', /Reports & analytics/],
  ['/reports/budget', /Reports & analytics/],
  ['/reports/accounts', /Reports & analytics/],
  ['/reports/debt', /Reports & analytics/],
  ['/reports/transfers', /Reports & analytics/],
  ['/planner', /Scenario planner/],
  ['/planner/scn-auto-extra', /Scenario planner/],
  ['/lab', /Test Lab/],
  ['/lab/inspect', /Test Lab/],
  ['/lab/edit', /Test Lab/],
  ['/lab/reference', /Test Lab/],
  ['/lab/compare', /Test Lab/],
  ['/lab/verify', /Test Lab/],
  ['/settings', /Settings & data management/],
  ['/nowhere', /Page not found/],
];

describe('every page renders on the seeded demo without a crash', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  for (const [route, heading] of ROUTES) {
    it(`renders ${route}`, () => {
      const { container } = renderApp(route);
      expect(screen.getAllByRole('heading', { level: 1 }).some((h) => heading.test(h.textContent))).toBe(true);
      expect(screen.queryByText(/hit a problem/i)).toBeNull();
      expect(container.textContent).not.toMatch(/NaN|undefined|\[object Object\]/);
    });
  }
  it('has primary navigation to all eleven areas', () => {
    renderApp('/');
    const nav = screen.getByRole('navigation', { name: /main navigation/i });
    const names = within(nav).getAllByRole('link').map((a) => a.textContent.trim());
    expect(names).toEqual(['Dashboard', 'Accounts', 'Transactions', 'Import & Reconcile', 'Budgets', 'Recurring & Bills', 'Goals & Debt', 'Reports & Analytics', 'Scenario Planner', 'Test Lab', 'Settings / Data']);
  });
});
