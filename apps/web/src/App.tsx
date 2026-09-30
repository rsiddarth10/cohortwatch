import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, openLive, type Me } from './api';
import { login, logout, userManager } from './auth';
import { Agent } from './pages/Agent';
import { Board, BoardHome } from './pages/Board';
import { CampaignPage, Campaigns } from './pages/Campaign';
import { Vehicle } from './pages/Vehicle';

function Callback({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  useEffect(() => {
    userManager.signinRedirectCallback().then(
      () => {
        onDone();
        nav('/', { replace: true });
      },
      () => nav('/', { replace: true }),
    );
  }, [nav, onDone]);
  return <p className="muted pad">Signing in…</p>;
}

function Welcome() {
  return (
    <div className="welcome">
      <h1>CohortWatch</h1>
      <p>The daily workshop queue that ranks vans by real risk and catches shared outbreaks early.</p>
      <button className="primary" onClick={() => void login()}>
        Sign in
      </button>
      <p className="muted small">Demo logins: lead / lead-demo · planner / planner-demo · viewer / viewer-demo</p>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    userManager.getUser().then(async (u) => {
      if (u && !u.expired) {
        try {
          setMe(await api<Me>('/me'));
          void openLive();
        } catch {
          setMe(null);
        }
      }
      setChecked(true);
    });
  }, [tick]);

  if (window.location.pathname === '/callback')
    return (
      <Routes>
        <Route path="/callback" element={<Callback onDone={() => setTick((t) => t + 1)} />} />
      </Routes>
    );
  if (!checked) return null;
  if (!me) return <Welcome />;

  return (
    <div className="shell">
      <header className="top">
        <Link to="/" className="brand">
          Cohort<b>Watch</b>
        </Link>
        <nav>
          <NavLink to="/" end>
            Board
          </NavLink>
          <NavLink to="/campaigns">Campaigns</NavLink>
          <NavLink to="/agent">Agent &amp; audit</NavLink>
        </nav>
        <div className="who">
          <span className={`role role-${me.role}`}>{me.role}</span>
          <span>{me.name}</span>
          <button className="ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      {me.role === 'viewer' && (
        <div className="banner">Viewer: read-only; precise locations and drivers are hidden.</div>
      )}
      <main>
        <Routes>
          <Route path="/" element={<BoardHome />} />
          <Route path="/depots/:id" element={<Board me={me} />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignPage me={me} />} />
          <Route path="/vehicles/:vin" element={<Vehicle me={me} />} />
          <Route path="/agent" element={<Agent me={me} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
