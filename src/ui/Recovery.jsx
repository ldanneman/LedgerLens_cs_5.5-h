import { useState } from 'react';
import { useStore } from '../state/hooks.jsx';
import { downloadText, readFileText } from './format.js';
import { parseImportText, MAX_IMPORT_CHARS } from '../persistence/serialize.js';

/** Shown instead of the app when saved data cannot be read. Nothing is overwritten until the user chooses. */
export default function Recovery({ recovery }) {
  const store = useStore();
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(null);
  const importFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await readFileText(f, MAX_IMPORT_CHARS);
      const r = parseImportText(text);
      if (!r.ok) {
        setMsg(`That file cannot be used: ${r.error}`);
        return;
      }
      setDone(store.resolveRecovery('import', r.dataset));
    } catch (err) {
      setMsg(err.message);
    }
  };
  return (
    <main className="content" style={{ maxWidth: 760 }} id="main-content">
      <h1>LedgerLens could not read your saved data</h1>
      <div className="callout error" role="alert">
        <p>
          <strong>Nothing has been deleted.</strong> {recovery.reason}
        </p>
        <p className="small">The unreadable data is still stored exactly as it was. Choose how to continue:</p>
      </div>
      <div className="stack" style={{ marginTop: 16 }}>
        <section className="card">
          <h2>1. Keep a copy of the unreadable data</h2>
          <p>Download it so you (or someone helping you) can inspect or repair it.</p>
          <button type="button" className="btn" onClick={() => downloadText('ledgerlens-unreadable-data.json', recovery.raw)}>
            Download the raw saved data
          </button>
        </section>
        <section className="card">
          <h2>2. Restore from a LedgerLens export file</h2>
          <p>If you exported your data earlier, load that file. The unreadable data is backed up under a separate key first.</p>
          <label className="field">
            <span>Export file (.json)</span>
            <input type="file" accept="application/json,.json" onChange={importFile} />
          </label>
        </section>
        <section className="card">
          <h2>3. Start again with the demo data</h2>
          <p>Loads the deterministic demo world. The unreadable data is kept as a backup in this browser (see Settings / Data).</p>
          <button type="button" className="btn primary" onClick={() => setDone(store.resolveRecovery('demo'))}>
            Start with demo data
          </button>
        </section>
        {msg && <p className="error-text" role="alert">{msg}</p>}
        {done && <p role="status">Recovered. A backup was saved as {done.backupKey}.</p>}
        {recovery.findings?.length > 0 && (
          <details className="explain">
            <summary>Technical details ({recovery.findings.length} findings)</summary>
            <div>
              <ul>
                {recovery.findings.slice(0, 20).map((f, i) => (
                  <li key={i}>{f.message}</li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </div>
    </main>
  );
}
