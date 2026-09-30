import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, when, type Me } from '../api';
import { useData } from '../hooks';
import { TAG } from './Board';

interface VehicleData {
  vin: string;
  model: string;
  powertrain: string;
  duty: string;
  model_year: number;
  status: string;
  depot: { id: number; code: string; region: string; lat?: number; lon?: number; geohash5: string };
  driver: { id: number; pseudonym: string } | null;
  incidents: {
    id: string;
    fault_family: string;
    metric: string;
    status: string;
    severity: string;
    runaway: boolean;
    opened_ts: string;
    hours_to_limit: number | null;
    clues: { type: string; text: string }[] | null;
  }[];
  repairs: { id: string; repaired_ts: string; status: string; driven_hours: number | null; text: string | null }[];
  fix_status: string | null;
  queue: {
    depot_id: number;
    rank: number;
    slot: string;
    reasons: { type: string; text: string }[];
    cost_text: string;
  } | null;
  campaigns: { id: string; fault_family: string; status: string; fixed: boolean }[];
}
interface Normal {
  metric: string;
  unit: string;
  band: { median: number; lo: number; hi: number; source: string } | null;
  series: { t: string; value: number }[];
  incidents: { id: string; fault_family: string; runaway: boolean; opened_ts: string }[];
  repairs: { repaired_ts: string; status: string }[];
}

const METRICS = [
  ['coolant_c', 'Coolant'],
  ['batt_temp_c', 'Battery temp'],
  ['lv_batt_v', '12 V battery'],
] as const;
const fmt = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit' });

export function Vehicle({ me }: { me: Me }) {
  const { vin = '' } = useParams();
  const [metric, setMetric] = useState<string>('');
  const v = useData(
    () => api<VehicleData>(`/vehicles/${vin}`),
    [vin],
    ['queue'],
    (_t, d) => {
      const items = (d as { items?: { vin: string }[] }).items ?? [];
      return items.some((i) => i.vin === vin);
    },
  );
  // default chart: the metric of the van's latest incident (else the API's default for its powertrain)
  const shown = metric || (v.data ? (v.data.incidents[0]?.metric ?? '') : null);
  const n = useData(
    () =>
      shown === null ? Promise.resolve(null) : api<Normal>(`/vehicles/${vin}/normal${shown ? `?metric=${shown}` : ''}`),
    [vin, shown],
  );
  const [msg, setMsg] = useState<string | null>(null);

  if (v.error) return <p className="error pad">{v.error}</p>;
  if (!v.data) return <p className="muted pad">Loading…</p>;
  const x = v.data;
  const repair = async () => {
    try {
      await api(`/vehicles/${vin}/repair`, { method: 'POST', body: {} });
      setMsg('Repair recorded. The fix is confirmed once its next driven hours sit back inside its normal.');
      setTimeout(v.reload, 1500);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const band = n.data?.band;
  const points = (n.data?.series ?? []).map((s) => ({
    t: new Date(s.t).getTime(),
    value: s.value,
    band: band ? [band.lo, band.hi] : undefined,
  }));
  return (
    <div className="page">
      <div className="bar">
        <h1 className="vin">{x.vin}</h1>
        <span className="muted">
          {x.model} ({x.powertrain.toLowerCase()}) · {x.duty} · {x.model_year} ·{' '}
          <Link to={`/depots/${x.depot.id}`}>{x.depot.code}</Link> · {x.depot.region}
          {x.depot.lat !== undefined
            ? ` · ${x.depot.lat.toFixed(3)}, ${x.depot.lon?.toFixed(3)}`
            : ` · area ${x.depot.geohash5}`}
          {' · driver '}
          {x.driver ? x.driver.pseudonym : me.role === 'viewer' ? 'hidden' : 'none'}
        </span>
        {(me.role === 'planner' || me.role === 'lead') && (
          <button className="primary" onClick={() => void repair()}>
            Record repair
          </button>
        )}
      </div>
      {msg && <p className="note">{msg}</p>}
      <div className="kpis">
        <div>
          <b>{x.queue ? `#${x.queue.rank}` : '—'}</b>
          {x.queue ? `${x.queue.slot.toLowerCase()} · ${x.queue.cost_text}` : 'not in the queue'}
        </div>
        <div>
          <b className={x.fix_status === 'NOT_FIXED' ? 'crit' : ''}>{x.fix_status?.replace('_', ' ') ?? '—'}</b>fix
          status
        </div>
        <div>
          <b>{x.incidents.filter((i) => i.status !== 'CLOSED').length}</b>open incidents
        </div>
        <div>
          <b>{x.campaigns.length}</b>
          {x.campaigns.map((c) => (
            <Link key={c.id} to={`/campaigns/${c.id}`}>
              {c.fault_family} campaign{c.fixed ? ' (fixed)' : ''}
            </Link>
          ))}
          {x.campaigns.length === 0 && 'campaigns'}
        </div>
      </div>
      {x.queue && (
        <div className="more">
          {x.queue.reasons.map((r) => (
            <span key={r.text} className={`chip tag-${TAG[r.type] ?? 'plain'}`}>
              {r.text}
            </span>
          ))}
        </div>
      )}
      <section>
        <div className="bar">
          <h2>Compared to its own normal</h2>
          {METRICS.map(([m, label]) => (
            <button
              key={m}
              className={(metric || n.data?.metric) === m ? 'tab on' : 'tab'}
              onClick={() => setMetric(m)}
            >
              {label}
            </button>
          ))}
          {band && (
            <span className="muted small">
              band = its {band.source === 'VAN' ? 'own' : 'cohort'} median ± 3 robust SD · red = incident · green =
              repair
            </span>
          )}
        </div>
        <div className="chart">
          {points.length === 0 ? (
            <p className="muted pad">No hourly readings yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={points} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" strokeDasharray="3 3" />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={fmt} scale="time" />
                <YAxis unit={` ${n.data?.unit ?? ''}`} width={70} domain={['auto', 'auto']} />
                <Tooltip
                  labelFormatter={(t) => fmt(Number(t))}
                  formatter={(val) =>
                    Array.isArray(val) ? val.map((z) => Number(z).toFixed(1)).join(' – ') : Number(val).toFixed(2)
                  }
                />
                {band && (
                  <Area dataKey="band" stroke="none" fill="var(--band)" isAnimationActive={false} name="normal band" />
                )}
                {band && <ReferenceLine y={band.median} stroke="var(--muted)" strokeDasharray="4 4" />}
                <Line
                  dataKey="value"
                  dot={false}
                  stroke="var(--accent)"
                  strokeWidth={1.6}
                  isAnimationActive={false}
                  name="hourly mean"
                />
                {(n.data?.incidents ?? []).map((i) => (
                  <ReferenceLine
                    key={i.id}
                    x={new Date(i.opened_ts).getTime()}
                    stroke="var(--crit)"
                    label={{
                      value: i.runaway ? 'runaway' : i.fault_family.toLowerCase(),
                      fill: 'var(--crit)',
                      fontSize: 11,
                      position: 'insideTopLeft',
                    }}
                  />
                ))}
                {(n.data?.repairs ?? []).map((r) => (
                  <ReferenceLine
                    key={r.repaired_ts}
                    x={new Date(r.repaired_ts).getTime()}
                    stroke="var(--ok)"
                    strokeWidth={2}
                    label={{
                      value: `repair: ${r.status.toLowerCase()}`,
                      fill: 'var(--ok)',
                      fontSize: 11,
                      position: 'insideBottomLeft',
                    }}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>
      <div className="cols">
        <section>
          <h2>Incidents</h2>
          {x.incidents.length === 0 && <p className="muted small">none</p>}
          {x.incidents.map((i) => (
            <div key={i.id} className="watch">
              <b>{i.fault_family}</b> · {i.severity.toLowerCase()} · {i.status.toLowerCase()}
              {i.runaway && <span className="chip tag-crit">runaway ≈ {i.hours_to_limit?.toFixed(0)} h to limit</span>}
              <span className="muted small"> · {when(i.opened_ts)}</span>
              <ul className="clues small">
                {(i.clues ?? []).map((k) => (
                  <li key={k.text}>{k.text}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
        <aside>
          <h2>Repairs</h2>
          {x.repairs.length === 0 && <p className="muted small">none</p>}
          {x.repairs.map((r) => (
            <div key={r.id} className="watch small">
              <span className={`status st-${r.status}`}>{r.status.replace('_', ' ')}</span> {when(r.repaired_ts)}
              {r.driven_hours != null && ` · ${r.driven_hours} h driven since`}
              {r.text && <div className="muted">{r.text}</div>}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
