import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, when, type Me } from '../api';
import { useData } from '../hooks';

interface Proposal {
  id: string;
  depot_id: number | null;
  depot: string | null;
  campaign_id: string | null;
  action_type: string;
  title: string;
  body: string;
  evidence: { source: string; id: string; text: string }[];
  diff: { changes: { vin: string; from: string; to: string }[]; summary: string };
  status: string;
  version: number;
  created_by: string;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}
interface AuditRow {
  id: number;
  at: string;
  actor: string;
  role: string;
  action: string;
  resource: string;
  resource_id: string | null;
}

function Audit() {
  const [extra, setExtra] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const first = useData(
    () =>
      api<{ items: AuditRow[]; next: string | null }>('/audit?limit=30').then((r) => {
        setExtra([]);
        setNext(r.next);
        return r;
      }),
    [],
  );
  const more = async () => {
    if (!next) return;
    const r = await api<{ items: AuditRow[]; next: string | null }>(`/audit?limit=30&after=${next}`);
    setExtra((e) => [...e, ...r.items]);
    setNext(r.next);
  };
  return (
    <section>
      <h2>
        Audit trail <small>every view and action, newest first (also on audit.v1)</small>
      </h2>
      <table className="list wide small">
        <thead>
          <tr>
            <th>When (wall)</th>
            <th>Who</th>
            <th>Role</th>
            <th>Action</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          {[...(first.data?.items ?? []), ...extra].map((a) => (
            <tr key={a.id}>
              <td className="nowrap">{when(a.at)}</td>
              <td>{a.actor}</td>
              <td>{a.role}</td>
              <td>{a.action}</td>
              <td>
                {a.resource}
                {a.resource_id && <span className="muted"> {a.resource_id}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {next && (
        <button className="ghost" onClick={() => void more()}>
          Load more
        </button>
      )}
    </section>
  );
}

export function Agent({ me }: { me: Me }) {
  const [status, setStatus] = useState('PENDING');
  const p = useData(() => api<{ items: Proposal[] }>(`/proposals?status=${status}&limit=50`), [status], ['proposal']);
  const [msg, setMsg] = useState<string | null>(null);
  const decide = async (x: Proposal, d: 'approve' | 'reject') => {
    try {
      await api(`/proposals/${x.id}/${d}`, { method: 'POST', version: x.version });
      setMsg(
        d === 'approve'
          ? `Approved. The workshop re-plans ${x.depot}'s bays; the board updates live.`
          : 'Rejected. Nothing changes.',
      );
      p.reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
      p.reload();
    }
  };
  return (
    <div className="page">
      <div className="bar">
        <h1>Agent proposals</h1>
        {['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'].map((s) => (
          <button key={s} className={s === status ? 'tab on' : 'tab'} onClick={() => setStatus(s)}>
            {s.toLowerCase()}
          </button>
        ))}
        <span className="muted small">
          The agent adds notes on its own; anything that moves vans between bays waits here for a lead.
        </span>
      </div>
      {msg && <p className="note">{msg}</p>}
      {p.data?.items.length === 0 && <p className="muted pad">No {status.toLowerCase()} proposals.</p>}
      <div className="proposals">
        {(p.data?.items ?? []).map((x) => (
          <article key={x.id} className="proposal">
            <div className="bar">
              <span className={`status st-${x.status}`}>{x.status}</span>
              <b>{x.title}</b>
            </div>
            <p>{x.body}</p>
            <div className="cols2">
              <div>
                <h3>Evidence</h3>
                <ul className="clues small">
                  {x.evidence.map((e) => (
                    <li key={e.id}>
                      {e.text} <span className="muted">[{e.id.split('#')[1] ?? e.id}]</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Dry run</h3>
                <table className="list small">
                  <tbody>
                    {x.diff.changes.map((c) => (
                      <tr key={c.vin}>
                        <td>
                          <Link to={`/vehicles/${c.vin}`} className="vin">
                            {c.vin}
                          </Link>
                        </td>
                        <td>
                          {c.from.toLowerCase()} → <b>{c.to.toLowerCase()}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="actions">
              {x.campaign_id && <Link to={`/campaigns/${x.campaign_id}`}>campaign</Link>}
              {x.depot_id && <Link to={`/depots/${x.depot_id}`}>board {x.depot}</Link>}
              <span className="muted small">
                by {x.created_by} · {when(x.created_at)}
                {x.decided_by && ` · ${x.status.toLowerCase()} by ${x.decided_by} ${when(x.decided_at)}`}
              </span>
              {x.status === 'PENDING' && me.role === 'lead' && (
                <>
                  <button className="primary" onClick={() => void decide(x, 'approve')}>
                    Approve
                  </button>
                  <button className="ghost" onClick={() => void decide(x, 'reject')}>
                    Reject
                  </button>
                </>
              )}
              {x.status === 'PENDING' && me.role !== 'lead' && (
                <span className="muted small">only a lead can approve</span>
              )}
            </div>
          </article>
        ))}
      </div>
      {me.role === 'lead' ? <Audit /> : <p className="muted small pad">The audit trail is visible to leads.</p>}
    </div>
  );
}
