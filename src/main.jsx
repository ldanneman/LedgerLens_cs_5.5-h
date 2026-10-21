import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './styles/app.css';
import { AppShell } from './App.jsx';
import { createStore } from './state/store.js';
import { createStorage, detectBackend } from './persistence/storage.js';

const { backend, persistent, reason } = detectBackend();
const store = createStore({ storage: createStorage(backend), persistent, persistWarning: reason });

/** Keep the document theme in sync with the saved preference. */
function ThemeSync() {
  useEffect(() => {
    const apply = () => {
      const t = store.getState().prefs?.theme || 'system';
      if (t === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
    };
    apply();
    return store.subscribe(apply);
  }, []);
  return null;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <ThemeSync />
      <AppShell store={store} />
    </HashRouter>
  </StrictMode>,
);
