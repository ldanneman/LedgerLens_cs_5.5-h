import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { StoreProvider, ToastProvider, useAppState, useToasts } from './state/hooks.jsx';
import { ConfirmProvider } from './ui/components/Modal.jsx';
import { EditorsProvider } from './ui/modals/Editors.jsx';
import Layout from './ui/Layout.jsx';
import Recovery from './ui/Recovery.jsx';
import { Boundary } from './ui/components/Common.jsx';
import Dashboard from './ui/pages/Dashboard.jsx';
import Accounts from './ui/pages/Accounts.jsx';
import AccountDetail from './ui/pages/AccountDetail.jsx';
import Transactions from './ui/pages/Transactions.jsx';
import ImportReconcile from './ui/pages/ImportReconcile.jsx';
import Budgets from './ui/pages/Budgets.jsx';
import Recurring from './ui/pages/Recurring.jsx';
import GoalsDebt from './ui/pages/GoalsDebt.jsx';
import Reports from './ui/pages/Reports.jsx';
import Planner from './ui/pages/Planner.jsx';
import TestLab from './ui/pages/TestLab.jsx';
import Settings from './ui/pages/Settings.jsx';
import NotFound from './ui/pages/NotFound.jsx';

function GlobalErrors() {
  const { push } = useToasts();
  useEffect(() => {
    const onError = (e) => push({ kind: 'error', title: 'Something went wrong', message: `${e.message || 'An unexpected error occurred'}. Your data is safe; you can keep working.` });
    const onRejection = (e) => push({ kind: 'error', title: 'Something went wrong', message: `${e.reason?.message || 'An operation failed'}. Your data is safe.` });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [push]);
  return null;
}

function Routed() {
  const st = useAppState();
  if (st.status === 'recovery') return <Recovery recovery={st.recovery} />;
  return (
    <EditorsProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:accountId" element={<AccountDetail />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/transactions/:view" element={<Transactions />} />
          <Route path="/import" element={<ImportReconcile />} />
          <Route path="/import/:tab" element={<ImportReconcile />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/budgets/:categoryId" element={<Budgets />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/goals" element={<GoalsDebt />} />
          <Route path="/goals/:tab" element={<GoalsDebt />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/:view" element={<Reports />} />
          <Route path="/planner" element={<Planner />} />
          <Route path="/planner/:scenarioId" element={<Planner />} />
          <Route path="/lab" element={<TestLab />} />
          <Route path="/lab/:tab" element={<TestLab />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
    </EditorsProvider>
  );
}

/** Everything inside a Router: providers, chrome and routes. */
export function AppShell({ store }) {
  return (
    <StoreProvider store={store}>
      <ToastProvider>
        <ConfirmProvider>
          <GlobalErrors />
          <Boundary name="LedgerLens">
            <Routed />
          </Boundary>
        </ConfirmProvider>
      </ToastProvider>
    </StoreProvider>
  );
}
