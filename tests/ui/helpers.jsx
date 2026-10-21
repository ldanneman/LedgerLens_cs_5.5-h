import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../../src/App.jsx';
import { createStore } from '../../src/state/store.js';
import { createStorage, createMemoryBackend } from '../../src/persistence/storage.js';

/** Build a store over an in-memory backend (a stand-in for localStorage). */
export function makeStore(backend = createMemoryBackend()) {
  return { backend, store: createStore({ storage: createStorage(backend), now: () => '2026-10-01T12:00:00.000Z' }) };
}

/** Render the whole application at a route. Returns the RTL result plus the store/backend. */
export function renderApp(route = '/', ctx = makeStore()) {
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <AppShell store={ctx.store} />
    </MemoryRouter>,
  );
  return { ...utils, ...ctx };
}
