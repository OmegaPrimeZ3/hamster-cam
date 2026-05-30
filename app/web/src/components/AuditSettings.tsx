// app/web/src/components/AuditSettings.tsx
//
// Read-only paginated audit_log viewer. Filter chips on top: actor, action
// prefix, time window. Each row expands to show the JSON details. Export
// button dumps the current view as JSON.

import { useEffect, useMemo, useState } from 'react';
import { Download, Filter } from 'lucide-react';
import { trpc, RouterOutputs } from '../trpc';
import { useNow } from '../hooks/useNow';
import { relativeTime } from '../lib/time';

type AuditRow = RouterOutputs['audit']['list']['items'][number];

const TIME_WINDOWS: Array<{ id: 'today' | '7d' | '30d' | 'all'; label: string; sinceFn: () => number | null }> = [
  { id: 'today', label: 'Today', sinceFn: () => startOfDay() },
  { id: '7d', label: '7d', sinceFn: () => Date.now() - 7 * 86_400_000 },
  { id: '30d', label: '30d', sinceFn: () => Date.now() - 30 * 86_400_000 },
  { id: 'all', label: 'All', sinceFn: () => null },
];

function startOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function AuditSettings(): JSX.Element {
  const users = trpc.users.list.useQuery();
  const now = useNow(60_000);
  const [windowId, setWindowId] = useState<'today' | '7d' | '30d' | 'all'>('7d');
  const [actorId, setActorId] = useState<number | null>(null);
  const [actionPrefix, setActionPrefix] = useState<string>('');
  const [collected, setCollected] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const since = useMemo(() => TIME_WINDOWS.find((w) => w.id === windowId)?.sinceFn() ?? null, [windowId]);

  useEffect(() => {
    setCollected([]);
    setCursor(null);
  }, [windowId, actorId, actionPrefix]);

  const list = trpc.audit.list.useQuery({
    cursor,
    limit: 50,
    actor_user_id: actorId,
    action_prefix: actionPrefix || null,
    since,
    until: null,
  });

  useEffect(() => {
    if (!list.data) return;
    setCollected((prev) => {
      // append, avoiding duplicates by id
      const seen = new Set(prev.map((r) => r.id));
      const next = prev.slice();
      for (const r of list.data.items) {
        if (!seen.has(r.id)) next.push(r);
      }
      return next;
    });
  }, [list.data]);

  function downloadJson(): void {
    const blob = new Blob([JSON.stringify(collected, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${windowId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 className="display" style={{ margin: 0 }}>Audit log</h3>
        <button type="button" className="hc-btn" onClick={downloadJson} disabled={collected.length === 0}>
          <Download aria-hidden size={16} /> Download
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {TIME_WINDOWS.map((w) => (
          <button
            key={w.id}
            type="button"
            className="hc-chip"
            onClick={() => setWindowId(w.id)}
            aria-pressed={windowId === w.id}
            style={{
              padding: '6px 12px',
              cursor: 'pointer',
              background: windowId === w.id ? 'var(--accent)' : 'var(--surface-raised)',
              color: windowId === w.id ? 'var(--accent-text)' : 'var(--text)',
              borderColor: windowId === w.id ? 'transparent' : 'var(--border)',
            }}
          >
            {w.label}
          </button>
        ))}
        <select
          className="hc-input"
          aria-label="Filter by actor"
          value={actorId ?? ''}
          onChange={(e) => setActorId(e.target.value ? Number(e.target.value) : null)}
          style={{ width: 'auto', minHeight: 36, padding: '4px 10px' }}
        >
          <option value="">All actors</option>
          {(users.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>{u.display_name}</option>
          ))}
        </select>
        <select
          className="hc-input"
          aria-label="Action prefix"
          value={actionPrefix}
          onChange={(e) => setActionPrefix(e.target.value)}
          style={{ width: 'auto', minHeight: 36, padding: '4px 10px' }}
        >
          <option value="">All actions</option>
          <option value="users.">users.*</option>
          <option value="cameras.">cameras.*</option>
          <option value="settings.">settings.*</option>
          <option value="recipients.">recipients.*</option>
          <option value="admin.">admin.*</option>
        </select>
        <span aria-hidden style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Filter size={14} />
        </span>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {collected.map((row) => {
          const isOpen = expanded.has(row.id);
          const actor = (users.data ?? []).find((u) => u.id === row.actor_user_id);
          return (
            <li key={row.id} className="hc-card" style={{ padding: 10 }}>
              <button
                type="button"
                onClick={() => {
                  setExpanded((s) => {
                    const next = new Set(s);
                    if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                    return next;
                  });
                }}
                aria-expanded={isOpen}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  gap: 8,
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'inherit',
                }}
              >
                <small style={{ color: 'var(--text-muted)', width: 110 }}>{relativeTime(row.at, now)}</small>
                <strong>{actor?.display_name ?? (row.actor_user_id == null ? 'system' : `#${row.actor_user_id}`)}</strong>
                <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{row.action}</code>
                {row.target_type && (
                  <span className="hc-chip">{row.target_type}{row.target_id ? ` ${row.target_id}` : ''}</span>
                )}
              </button>
              {isOpen && row.details && (
                <pre
                  style={{
                    margin: '8px 0 0',
                    background: 'var(--surface-raised)',
                    padding: 10,
                    borderRadius: 8,
                    overflowX: 'auto',
                    fontSize: 12,
                  }}
                >
                  {prettyJson(row.details)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>

      {list.data?.next_cursor != null && (
        <button
          type="button"
          className="hc-btn"
          onClick={() => list.data && setCursor(list.data.next_cursor)}
          disabled={list.isFetching}
        >
          {list.isFetching ? 'Loading…' : 'Load more'}
        </button>
      )}

      {!list.isLoading && collected.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>No audit rows yet.</p>
      )}
    </div>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
