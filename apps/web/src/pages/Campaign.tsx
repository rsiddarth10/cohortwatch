import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, inr, when, type Me } from '../api';
import { useData } from '../hooks';

interface CampaignRow {
  id: string;
  fault_family: string;
  status: string;
  member_count: number;
  at_risk_count: number;
  cost_inr: number | null;
  opened_ts: string | null;
  first_ts: string;
  depot: string;
  model: string;
  duty: string;
  p_value?: number | null;
  version: number;
}
interface Detail {
  campaign: CampaignRow & { depot_id: number; dismissal: { by: string; reason: string } | null };
  members: {
    vin: string;
    joined_ts: string;
    runaway: boolean;
    fixed: boolean;
    deviation: number | null;
    slope_per_h: number | null;
    last_code: string | null;
    firmware: string | null;
  }[];
  at_risk: { vin: string; first_ts: string; reason: string }[];
  clues: { ord: number; clue_type: string; text: string }[];
  similar: {
    rank: number;
    similarity: number;
    code: string;
    members: number;
    root_cause: string;
    resolution: string;
  }[];
  overrides: { action: string; by_user: string; reason: string; members_at: number; created_at: string }[];
  history: { type: string; members: number | null; ts: string | null; created_at: string }[];
  notes: { kind: string; vin: string | null; text: string }[];
  proposals: { id: string; action_type: string; title: string; status: string; version: number }[];
}

export function Campaigns() {
  const [status, setStatus] = useState('OPEN');
  const [extra, setExtra] = useState<CampaignRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const page = useData(
    () =>
      api<{ items: CampaignRow[]; next: string | null }>(`/campaigns?status=${status}&limit=25`).then((r) => {
        setExtra([]);
        setNext(r.next);
        return r;
      }),
    [status],
    ['campaign'],
  );
  const more = async () => {
    if (!next) return;
    const r = await api<{ items: CampaignRow[]; next: string | null }>(
      `/campaigns?status=${status}&limit=25&after=${next}`,
    );
    setExtra((e) => [...e, ...r.items]);
    setNext(r.next);
  };
  const rows = [...(page.data?.items ?? []), ...extra];
  return (
    <div className="page">
      <div className="bar">
        <h1>Campaigns</h1>
        {['OPEN', 'WATCHING', 'CLOSED', 'DISMISSED'].map((s) => (
          <button key={s} className={s === status ? 'tab on' : 'tab'} onClick={() => setStatus(s)}>
            {s.toLowerCase()}
          </button>
        ))}
      </div>
      <table className="list wide">
        <thead>
          <tr>
            <th>Fault family</th>
            <th>Model · duty · depot</th>
            <th>Vans</th>
            <th>At-risk</th>
            <th>Cost of waiting</th>
            <th>Opened (sim)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/campaigns/${c.id}`}>{c.fault_family}</Link>
              </td>
              <td>
                {c.model} · {c.duty} · {c.depot}
              </td>
              <td>{c.member_count}</td>
              <td>{c.at_risk_count}</td>
              <td>{inr(c.cost_inr)}</td>
              <td>{when(c.opened_ts ?? c.first_ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && page.data && <p className="muted pad">No {status.toLowerCase()} campaigns.</p>}
      {next && (
        <button className="ghost" onClick={() => void more()}>
          Load more
        </button>
      )}
    </div>
  );
}

export function CampaignPage({ me }: { me: Me }) {
  const { id = '' } = useParams();
  const d = useData(
    () => api<Detail>(`/campaigns/${id}`),
    [id],
    ['campaign', 'proposal'],
    (t, x) => t === 'proposal' || (x as { campaignId?: string }).campaignId === id,
  );
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg(ok);
      d.reload();
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 409 ? `${e.message} (someone else acted first)` : String(e));
    }
  };
  if (d.error) return <p className="error pad">{d.error}</p>;
  if (!d.data) return <p className="muted pad">Loading…</p>;
  const { campaign: c } = d.data;
  const dismiss = () => {
    const reason = window.prompt('Why is this not an outbreak? (sticky: survives the next tick)');
    if (reason)
      void act(
        () => api(`/campaigns/${id}/dismiss`, { method: 'POST', body: { reason }, version: c.version }),
        'Dismissed.',
      );
  };
  return (
    <div className="page">
      <div className="bar">
        <h1>
          {c.fault_family} campaign · {c.model} · {c.duty} · <Link to={`/depots/${c.depot_id}`}>{c.depot}</Link>
        </h1>
        <span className={`status st-${c.status}`}>{c.status}</span>
        {me.role === 'lead' && (c.status === 'OPEN' || c.status === 'WATCHING') && (
          <button className="ghost" onClick={dismiss}>
            Not an outbreak…
          </button>
        )}
      </div>
      {msg && <p className="note">{msg}</p>}
      <div className="kpis">
        <div>
          <b>{c.member_count}</b>vans with the fault
        </div>
        <div>
          <b>{c.at_risk_count}</b>at-risk sisters
        </div>
        <div>
          <b>{inr(c.cost_inr)}</b>cost of waiting
        </div>
        <div>
          <b>{when(c.opened_ts)}</b>opened (sim time)
        </div>
      </div>
      <div className="cols">
        <section>
          <h2>Why we think it is one outbreak</h2>
          <ul className="clues">
            {d.data.clues.map((k) => (
              <li key={k.ord}>
                <span className="chip">{k.clue_type.toLowerCase()}</span> {k.text}
              </li>
            ))}
          </ul>
          <h2>
            Members <small>{d.data.members.length}</small>
          </h2>
          <table className="list wide">
            <thead>
              <tr>
                <th>VIN</th>
                <th>Above own normal</th>
                <th>Trend /h</th>
                <th>Code</th>
                <th>Firmware</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {d.data.members.map((m) => (
                <tr key={m.vin}>
                  <td>
                    <Link to={`/vehicles/${m.vin}`} className="vin">
                      {m.vin}
                    </Link>
                  </td>
                  <td>{m.deviation == null ? '—' : m.deviation.toFixed(1)}</td>
                  <td>{m.slope_per_h == null ? '—' : m.slope_per_h.toFixed(2)}</td>
                  <td>{m.last_code ?? '—'}</td>
                  <td>{m.firmware ?? '—'}</td>
                  <td>
                    {m.runaway && <span className="chip tag-crit">runaway</span>}
                    {m.fixed && <span className="chip tag-booked">fixed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <aside>
          <h2>
            At-risk sisters <small>not faulty yet</small>
          </h2>
          {d.data.at_risk.length === 0 && <p className="muted small">none right now</p>}
          {d.data.at_risk.map((a) => (
            <div key={a.vin} className="watch">
              <Link to={`/vehicles/${a.vin}`} className="vin">
                {a.vin}
              </Link>
              <div className="small">{a.reason}</div>
            </div>
          ))}
          <h2>Agent</h2>
          {d.data.proposals.map((p) => (
            <div key={p.id} className="proposal small">
              <span className={`status st-${p.status}`}>{p.status}</span> {p.title}
              {p.status === 'PENDING' && me.role === 'lead' && (
                <div className="actions">
                  <button
                    className="primary"
                    onClick={() =>
                      void act(
                        () => api(`/proposals/${p.id}/approve`, { method: 'POST', version: p.version }),
                        'Approved: the workshop re-plans the bays; the board updates live.',
                      )
                    }
                  >
                    Approve
                  </button>
                  <Link to="/agent">evidence &amp; dry run</Link>
                </div>
              )}
            </div>
          ))}
          {d.data.notes.map((n) => (
            <div key={`${n.kind}${n.vin}`} className="small muted note-line">
              {n.text}
            </div>
          ))}
          {d.data.similar.length > 0 && (
            <>
              <h2>Looks like</h2>
              {d.data.similar.map((s) => (
                <div key={s.code} className="small watch">
                  <b>{s.code}</b> ({Math.round(s.similarity * 100)}% similar, {s.members} vans): {s.root_cause}.{' '}
                  <span className="muted">Fix: {s.resolution}</span>
                </div>
              ))}
            </>
          )}
          <h2>History</h2>
          <ol className="history small">
            {d.data.history.map((h, i) => (
              <li key={i}>
                {h.type.toLowerCase().replace('_', ' ')}
                {h.members != null && ` · ${h.members} vans`}
                <span className="muted"> · {when(h.ts ? new Date(Number(h.ts)).toISOString() : h.created_at)}</span>
              </li>
            ))}
            {d.data.overrides.map((o, i) => (
              <li key={`o${i}`}>
                dismissed by {o.by_user} at {o.members_at} vans: “{o.reason}”
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
