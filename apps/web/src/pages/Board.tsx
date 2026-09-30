import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, inr, when, type Me } from '../api';
import { useData } from '../hooks';

interface Reason {
  type: string;
  text: string;
}
interface Item {
  rank: number;
  slot: 'TODAY' | 'TOMORROW' | 'WAITING';
  vin: string;
  score: number;
  pinned: boolean;
  reasons: Reason[];
  cost_inr: number;
  cost_text: string;
}
interface Card {
  id: string;
  card_type: string;
  vin: string | null;
  campaign_id: string | null;
  title: string;
  event_ts: string;
  status: string;
}
interface Queue {
  depot: { id: number; code: string; region: string; lat?: number; lon?: number; geohash5: string };
  version: number;
  as_of_ts: string | null;
  bays: number;
  today: Item[];
  tomorrow: Item[];
  waiting: Item[];
  cards: Card[];
  watching: { id: string; fault_family: string; member_count: number; p_value: number | null }[];
}
interface Depot {
  id: number;
  code: string;
  region: string;
  open_campaigns: number;
  queued: number;
}
interface CampaignRow {
  id: string;
  fault_family: string;
  status: string;
  member_count: number;
  at_risk_count: number;
  cost_inr: number | null;
  depot: string;
  model: string;
  duty: string;
}

/** "/" → the depot with the most open campaigns (the API orders depots that way). */
export function BoardHome() {
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: Depot[] }>('/depots').then(
      (d) => (d.items[0] ? nav(`/depots/${d.items[0].id}`, { replace: true }) : setErr('no depots yet')),
      (e: Error) => setErr(e.message),
    );
  }, [nav]);
  return <p className="muted pad">{err ?? 'Loading depots…'}</p>;
}

export const TAG: Record<string, string> = {
  RUNAWAY: 'crit',
  NOT_FIXED: 'crit',
  CAMPAIGN: 'camp',
  AT_RISK: 'risk',
  BOOKED: 'booked',
  INCIDENT: 'warn',
};

function QueueCard({ it, bay }: { it: Item; bay?: number }) {
  const first = it.reasons[0];
  return (
    <Link to={`/vehicles/${it.vin}`} className={`qcard ${it.pinned ? 'pinned' : ''}`}>
      <div className="qhead">
        <span className="rank">#{it.rank}</span>
        {bay !== undefined && <span className="bay">bay {bay}</span>}
        <span className="vin">{it.vin}</span>
        <span className="score" title="risk score">
          {it.score.toFixed(2)}
        </span>
      </div>
      {first && <div className={`why tag-${TAG[first.type] ?? 'plain'}`}>{first.text}</div>}
      <div className="more">
        {it.reasons.slice(1, 3).map((r) => (
          <span key={r.text} className={`chip tag-${TAG[r.type] ?? 'plain'}`}>
            {r.text}
          </span>
        ))}
      </div>
      <div className="cost">{it.cost_text}</div>
    </Link>
  );
}

const cardLabel = (t: string) => (t === 'RUNAWAY' ? 'Runaway' : `Campaign ${t.replace('CAMPAIGN_', '').toLowerCase()}`);

export function Board({ me }: { me: Me }) {
  const { id } = useParams();
  const depotId = Number(id);
  const nav = useNavigate();
  const depots = useData(() => api<{ items: Depot[] }>('/depots'), []);
  const q = useData(
    () => api<Queue>(`/depots/${depotId}/queue`),
    [depotId],
    ['queue', 'card', 'proposal'],
    (_t, d) => {
      const dep = (d as { depot_id?: number | null }).depot_id;
      return dep === undefined || dep === null || dep === depotId;
    },
  );
  const camps = useData(
    () => api<{ items: CampaignRow[] }>('/campaigns?status=OPEN&limit=100'),
    [depotId],
    ['campaign'],
  );
  const data = q.data;
  const code = data?.depot.code;
  const open = (camps.data?.items ?? []).filter((c) => c.depot === code);

  return (
    <div className={`board ${q.flash ? 'flash' : ''}`}>
      <div className="bar">
        <select value={depotId} onChange={(e) => nav(`/depots/${e.target.value}`)}>
          {(depots.data?.items ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} · {d.region} {d.open_campaigns ? `· ${d.open_campaigns} open` : ''}
            </option>
          ))}
        </select>
        {data && (
          <span className="muted">
            {data.bays} bays · queue v{data.version} · as of {when(data.as_of_ts)} (sim time)
            {data.depot.lat !== undefined && (
              <>
                {' '}
                · {data.depot.lat.toFixed(3)}, {data.depot.lon?.toFixed(3)}
              </>
            )}
            {me.role === 'viewer' && <> · area {data.depot.geohash5}</>}
          </span>
        )}
        <span className={`live ${q.flash ? 'on' : ''}`}>● live</span>
      </div>
      {q.error && <p className="error">{q.error}</p>}
      {!data ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <>
          {data.cards.length > 0 && (
            <section className="strip">
              {data.cards.slice(0, 6).map((c) => (
                <Link
                  key={c.id}
                  to={c.campaign_id ? `/campaigns/${c.campaign_id}` : `/vehicles/${c.vin}`}
                  className={`alert ${c.card_type === 'RUNAWAY' ? 'crit' : 'camp'}`}
                >
                  <b>{cardLabel(c.card_type)}</b>
                  <span>{c.title}</span>
                  <small>{when(c.event_ts)}</small>
                </Link>
              ))}
            </section>
          )}
          {open.length > 0 && (
            <section className="strip">
              {open.map((c) => (
                <Link key={c.id} to={`/campaigns/${c.id}`} className="campcard">
                  <b>
                    {c.fault_family} · {c.model} · {c.duty}
                  </b>
                  <span>
                    {c.member_count} vans · {c.at_risk_count} at-risk sisters
                  </span>
                  <small>cost of waiting {inr(c.cost_inr)}</small>
                </Link>
              ))}
            </section>
          )}
          <div className="cols">
            <section>
              <h2>
                Today{' '}
                <small>
                  {Math.min(data.today.length, data.bays)} of {data.bays} bays
                </small>
              </h2>
              <div className="grid">
                {data.today.map((it, i) => (
                  <QueueCard key={it.vin} it={it} bay={i + 1} />
                ))}
                {Array.from({ length: Math.max(0, data.bays - data.today.length) }, (_, i) => (
                  <div key={i} className="qcard empty">
                    bay {data.today.length + i + 1} free
                  </div>
                ))}
              </div>
              <h2>
                Tomorrow <small>{data.tomorrow.length}</small>
              </h2>
              <div className="grid">
                {data.tomorrow.map((it) => (
                  <QueueCard key={it.vin} it={it} />
                ))}
                {data.tomorrow.length === 0 && <div className="muted small">nothing booked yet</div>}
              </div>
            </section>
            <aside>
              <h2>
                Waiting <small>{data.waiting.length}</small>
              </h2>
              <table className="list">
                <tbody>
                  {data.waiting.slice(0, 20).map((it) => (
                    <tr key={it.vin}>
                      <td className="rank">#{it.rank}</td>
                      <td>
                        <Link to={`/vehicles/${it.vin}`} className="vin">
                          {it.vin}
                        </Link>
                        <div className="small muted">{it.reasons[0]?.text}</div>
                      </td>
                      <td className="small nowrap">{inr(it.cost_inr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.watching.length > 0 && (
                <>
                  <h2>
                    Watching <small>not yet a campaign</small>
                  </h2>
                  {data.watching.map((w) => (
                    <div key={w.id} className="watch">
                      {w.fault_family}: {w.member_count} vans
                      {w.p_value != null && <span className="muted"> · p = {w.p_value.toExponential(1)}</span>}
                    </div>
                  ))}
                </>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
