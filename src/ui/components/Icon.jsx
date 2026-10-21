const PATHS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  accounts: 'M3 10h18M5 10V7l7-4 7 4v3M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18',
  transactions: 'M4 6h16M4 12h16M4 18h10',
  import: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3',
  budgets: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 0v9l6.4 3.7',
  recurring: 'M4 12a8 8 0 0114-5.3L20 9m0-5v5h-5M20 12a8 8 0 01-14 5.3L4 15m0 5v-5h5',
  goals: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.4 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z',
  reports: 'M4 20V10m6 10V4m6 16v-8m5 8H3',
  planner: 'M3 17l6-6 4 4 8-8m0 0h-5m5 0v5',
  lab: 'M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.3l2-1.6-2-3.4-2.4 1a7 7 0 00-2.2-1.3L14.3 3H9.7l-.4 2.4a7 7 0 00-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.6l-2 1.6 2 3.4 2.4-1a7 7 0 002.2 1.3l.4 2.4h4.6l.4-2.4a7 7 0 002.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zm9 16l-4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  info: 'M12 11v6m0-10v.01M12 3a9 9 0 100 18 9 9 0 000-18z',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1',
  check: 'M5 13l4 4L19 7',
};

export default function Icon({ name, size = 18, label }) {
  const d = PATHS[name] || PATHS.info;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <path d={d} />
    </svg>
  );
}
