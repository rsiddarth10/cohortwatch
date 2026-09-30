import { useCallback, useEffect, useRef, useState } from 'react';
import { onLive } from './api';

/** Loads data, and reloads it (debounced) when a live event of one of `live` types arrives and `match` accepts it. */
export function useData<T>(
  load: () => Promise<T>,
  deps: unknown[],
  live: string[] = [],
  match: (type: string, data: unknown) => boolean = () => true,
): { data: T | null; error: string | null; reload: () => void; flash: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const loadRef = useRef(load);
  const matchRef = useRef(match);
  loadRef.current = load;
  matchRef.current = match;
  const reload = useCallback(() => {
    loadRef.current().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    setData(null);
    reload();
  }, deps);
  useEffect(() => {
    if (live.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((type, d) => {
      if (!live.includes(type) || !matchRef.current(type, d)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        reload();
        setFlash(true);
        setTimeout(() => setFlash(false), 1200);
      }, 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [reload]);
  return { data, error, reload, flash };
}
