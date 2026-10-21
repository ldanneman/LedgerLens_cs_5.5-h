import { Link } from 'react-router-dom';
import { PageHead, Card } from '../components/Common.jsx';
import { NAV } from '../Layout.jsx';

export default function NotFound() {
  return (
    <>
      <PageHead title="Page not found">That address does not match anything in LedgerLens.</PageHead>
      <Card title="Where would you like to go?">
        <ul className="list-plain">
          {NAV.map((n) => (
            <li key={n.to}>
              <Link to={n.to}>{n.label}</Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
