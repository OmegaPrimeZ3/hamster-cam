// app/server/src/trpc.ts
// =====================================================================
// FROZEN CONTRACT — input/output shapes are final at tag `contract-v1`.
// Stage 2a may extend internals (procedure bodies) but the wire surface
// — Zod schemas on inputs and outputs — does not change without a
// contract bump per docs/EXECUTION.md.
// =====================================================================
//
// Three procedure builders:
//   publicProcedure    — unused; the public surface is the /auth/* REST routes
//   protectedProcedure — valid session, either role
//   adminProcedure     — role === 'admin', and audit-logs every mutation
//
// Read-only procedures across the board return zod-validated outputs so the
// frontend gets end-to-end inferred types via `inferRouterOutputs`.
// PLAN §5.4 (tRPC endpoints).

import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { z } from 'zod';

import { runDiskWatchJob } from './jobs/disk-watch.js';
import { runRetentionJob } from './jobs/retention.js';
import { runTimelapseJob } from './jobs/timelapse.js';

import * as db from './db.js';
import { resolveSession } from './session.js';
import * as frigate from './frigate.js';
import { triggerForgotPassword, registerAccount, ZyphrEmailTaken } from './zyphr.js';
import { saveManualSnapshot, getRecentEvents } from './narrator.js';
import { startShareJob } from './share.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AppContext {
  user: db.UserRow | null;
  sessionId: string | null;
  /** Fastify request — kept for handlers that need headers / IP. */
  req: CreateFastifyContextOptions['req'];
  res: CreateFastifyContextOptions['res'];
  /**
   * Per-request scratchpad. adminProcedure handlers that need a before-state
   * snapshot for audit-log details write it here (typically under key
   * `'before'`) and the audit resolver in `detailsFrom` reads it after the
   * mutation completes. Empty object on every request; never persists.
   */
  audit: Record<string, unknown>;
}

export function createContext(opts: CreateFastifyContextOptions): AppContext {
  const user = resolveSession(opts.req);
  return {
    user,
    sessionId: opts.req.sessionId ?? null,
    req: opts.req,
    res: opts.res,
    audit: {},
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const t = initTRPC.context<AppContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unauthenticated' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Admin procedure. Wraps the call in:
 *   - role check (403 for non-admins)
 *   - audit-log writer on success for mutations (we infer mutation-ness from
 *     the procedure type at build time via `meta`).
 *
 * Read-only admin procedures opt out by setting `meta({ audit: false })`.
 */
/**
 * Per-procedure audit-write configuration. Security-Review Finding 4
 * remediation: instead of always writing `target_id = null, details = null`,
 * we let each adminProcedure declare resolvers that read the affected row id
 * (and an optional details payload) from the procedure's input / result.
 *
 * Shapes the resolvers see:
 *   targetIdFrom(input, ctx)            — for "act on existing row" shapes
 *                                         where the id lives in the request.
 *   targetIdFromResult(result, ctx)     — for create-shaped procedures where
 *                                         the id only exists after `next()`.
 *   detailsFrom(input, result, ctx)     — arbitrary structured payload that
 *                                         gets JSON.stringify'd into the
 *                                         `details` audit-log column.
 *
 * The middleware calls these AFTER the inner procedure resolves (so create
 * resolvers see the new row, update resolvers see both the input and the
 * post-update result). Any resolver throwing → audit row is written with
 * whatever it produced before the throw (defensive: we never let an audit
 * resolver block the mutation it's auditing).
 */
interface AuditMetaConfig {
  /**
   * String overrides the default action label (which is the procedure path).
   * `false` disables audit-writing entirely — used by read-only admin routes.
   */
  action?: string | undefined;
  targetType?: string | undefined;
  targetIdFrom?: ((input: unknown, ctx: AppContext) => string | number | null | undefined) | undefined;
  targetIdFromResult?: ((
    result: unknown,
    input: unknown,
    ctx: AppContext,
  ) => string | number | null | undefined) | undefined;
  detailsFrom?: ((input: unknown, result: unknown, ctx: AppContext) => unknown) | undefined;
}

interface ProcedureMeta {
  /**
   * Audit configuration. `false` opts out entirely (read-only admin routes).
   * A bare string is the legacy shorthand for `{ action: '<string>' }` —
   * preserved so the broad migration to AuditMetaConfig doesn't churn every
   * existing call site at once.
   *
   * NEW shape (Finding 4): `{ action, targetType, targetIdFrom, ... }` so the
   * audit row carries the affected target_id and a JSON details payload.
   */
  audit?: false | string | AuditMetaConfig;
  /** Legacy: target_type column when `audit` is bare-string shorthand. */
  targetType?: string;
}

const tAdmin = initTRPC.context<AppContext>().meta<ProcedureMeta>().create();

export const adminProcedure = tAdmin.procedure.use(async ({
  ctx,
  next,
  path,
  type,
  meta,
  rawInput,
}) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'unauthenticated' });
  }
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'forbidden' });
  }

  const nextCtx = { ...ctx, user: ctx.user };
  const result = await next({ ctx: nextCtx });

  // Only audit successful mutations, and only when not explicitly opted out.
  if (type !== 'mutation' || !result.ok || meta?.audit === false) {
    return result;
  }

  // Resolve audit row fields out of either the legacy bare-string meta or the
  // new AuditMetaConfig object.
  const cfg: AuditMetaConfig = typeof meta?.audit === 'object' && meta.audit !== null
    ? meta.audit
    : {
        action: typeof meta?.audit === 'string' ? meta.audit : undefined,
        targetType: meta?.targetType,
      };

  // Resolvers are best-effort: a thrown resolver MUST NOT break the mutation
  // it's auditing. We just log nothing for that field.
  let targetId: string | null = null;
  try {
    if (cfg.targetIdFromResult) {
      const id = cfg.targetIdFromResult(result.data, rawInput, nextCtx);
      if (id !== null && id !== undefined) targetId = String(id);
    } else if (cfg.targetIdFrom) {
      const id = cfg.targetIdFrom(rawInput, nextCtx);
      if (id !== null && id !== undefined) targetId = String(id);
    }
  } catch {
    targetId = null;
  }

  let details: unknown = null;
  try {
    if (cfg.detailsFrom) {
      details = cfg.detailsFrom(rawInput, result.data, nextCtx);
    }
  } catch {
    details = null;
  }

  db.insertAudit({
    actor_user_id: ctx.user.id,
    action: cfg.action ?? path,
    target_type: cfg.targetType ?? null,
    target_id: targetId,
    details,
  });

  return result;
});

// ---------------------------------------------------------------------------
// Reusable Zod schemas (output projections that flow to the client)
// ---------------------------------------------------------------------------

const roleSchema = z.enum(['admin', 'child']);

const publicUserSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  display_name: z.string(),
  role: roleSchema,
  created_at: z.number().int(),
  last_seen_at: z.number().int(),
});
export type PublicUserDTO = z.infer<typeof publicUserSchema>;

const cameraSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  emoji: z.string(),
  stream_url: z.string(),
  position: z.number().int(),
  enabled: z.boolean(),
  created_at: z.number().int(),
  /** ms since epoch of Frigate's most recent frame; null = unknown. */
  last_frame_at: z.number().int().nullable(),
});
export type CameraDTO = z.infer<typeof cameraSchema>;

const diaryKindSchema = z.enum(['narrative', 'snapshot', 'timelapse']);
const diaryActivitySchema = z.enum([
  'wheel', 'food', 'water', 'bathroom', 'resting', 'tunnel', 'exploring', 'hiding',
  'transition', 'snapshot', 'timelapse',
]);

const diaryEntrySchema = z.object({
  id: z.number().int(),
  occurred_at: z.number().int(),
  kind: diaryKindSchema,
  activity: diaryActivitySchema.nullable(),
  narrative: z.string(),
  pet_name: z.string().nullable(),
  camera_id: z.number().int().nullable(),
  from_camera_id: z.number().int().nullable(),
  to_camera_id: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  snapshot_id: z.number().int().nullable(),
  media_path: z.string().nullable(),
});
export type DiaryEntryDTO = z.infer<typeof diaryEntrySchema>;

const badgeSchema = z.object({
  badge_id: z.string(),
  earned_at: z.number().int(),
});
export type BadgeDTO = z.infer<typeof badgeSchema>;

const auditLogSchema = z.object({
  id: z.number().int(),
  actor_user_id: z.number().int().nullable(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  details: z.string().nullable(),
  at: z.number().int(),
});
export type AuditLogDTO = z.infer<typeof auditLogSchema>;

const recipientSchema = z.object({
  id: z.number().int(),
  display_name: z.string(),
  email: z.string().email(),
  added_by: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type RecipientDTO = z.infer<typeof recipientSchema>;

const shareLogSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  recipient_id: z.number().int(),
  diary_entry_id: z.number().int(),
  status: z.enum(['queued', 'sent', 'failed']),
  sent_at: z.number().int().nullable(),
  error: z.string().nullable(),
  created_at: z.number().int(),
});
export type ShareLogDTO = z.infer<typeof shareLogSchema>;

// Mapper helpers — keep tRPC outputs decoupled from the raw row shapes so a
// future column addition doesn't accidentally leak through.

function cameraToDTO(row: db.CameraRow, lastFrameAt: number | null): CameraDTO {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    stream_url: row.stream_url,
    position: row.position,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    last_frame_at: lastFrameAt,
  };
}

function diaryToDTO(row: db.DiaryEntryRow): DiaryEntryDTO {
  return {
    id: row.id,
    occurred_at: row.occurred_at,
    kind: row.kind,
    activity: row.activity,
    narrative: row.narrative,
    pet_name: row.pet_name,
    camera_id: row.camera_id,
    from_camera_id: row.from_camera_id,
    to_camera_id: row.to_camera_id,
    duration_ms: row.duration_ms,
    snapshot_id: row.snapshot_id,
    media_path: row.media_path,
  };
}

// ---------------------------------------------------------------------------
// settings.*
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  pet_name: z.string(),
  pet_emoji: z.string(),
  theme: z.string(),
  theme_mode: z.enum(['light', 'dark', 'auto']),
  read_aloud: z.boolean(),
  auto_rotate: z.boolean(),
  onboarding_complete: z.boolean(),
  snapshot_retention_days: z.number().int().nonnegative(),
  timelapse_retention_days: z.number().int().nonnegative(),
  audit_retention_days: z.number().int().nonnegative(),
  disk_warn_pct: z.number().int().min(0).max(100),
  disk_critical_pct: z.number().int().min(0).max(100),
  transition_window_ms: z.number().int().nonnegative(),
  min_dwell_ms: z.number().int().nonnegative(),
  share_rate_limit_per_hour: z.number().int().nonnegative(),
});
export type SettingsDTO = z.infer<typeof settingsSchema>;

// Used to validate incoming partial updates.
const settingsUpdateSchema = settingsSchema.partial();

function parseSettingsKV(kv: db.SettingsKV): SettingsDTO {
  const get = (key: string, fallback: string): string => kv[key] ?? fallback;
  const num = (key: string, fallback: number): number => {
    const raw = kv[key];
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = kv[key];
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  };
  const mode = get('theme_mode', 'auto');
  return {
    pet_name: get('pet_name', ''),
    pet_emoji: get('pet_emoji', '🐾'),
    theme: get('theme', 'bubblegum'),
    theme_mode: mode === 'light' || mode === 'dark' ? mode : 'auto',
    read_aloud: bool('read_aloud', false),
    auto_rotate: bool('auto_rotate', false),
    onboarding_complete: bool('onboarding_complete', false),
    snapshot_retention_days: num('snapshot_retention_days', 90),
    timelapse_retention_days: num('timelapse_retention_days', 30),
    audit_retention_days: num('audit_retention_days', 365),
    disk_warn_pct: num('disk_warn_pct', 85),
    disk_critical_pct: num('disk_critical_pct', 95),
    transition_window_ms: num('transition_window_ms', 8000),
    min_dwell_ms: num('min_dwell_ms', 2000),
    share_rate_limit_per_hour: num('share_rate_limit_per_hour', 10),
  };
}

const settingsRouter = router({
  // settings.get — either role reads
  get: protectedProcedure
    .input(z.void())
    .output(settingsSchema)
    .query(() => parseSettingsKV(db.getSettings())),

  // settings.update — admin only; written one key at a time
  update: adminProcedure
    .meta({
      audit: {
        action: 'settings.update',
        targetType: 'settings',
        // Settings is a singleton — there's no row id, but we record a stable
        // marker so audit consumers don't have to special-case null target_id.
        targetIdFrom: () => 'settings',
        // Build a before/after diff against the snapshot the mutation
        // captured into ctx.audit.before before calling setSettings.
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(settingsUpdateSchema)
    .output(settingsSchema)
    .mutation(({ ctx, input }) => {
      // Capture the pre-update snapshot so the audit-detail resolver can build
      // the diff. Read from db.getSettings() not from `input` — input is a
      // partial; the snapshot needs the full state of every column the diff
      // might mention.
      ctx.audit['before'] = parseSettingsKV(db.getSettings());
      const kv: db.SettingsKV = {};
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        kv[key] = typeof value === 'boolean' ? String(value) : String(value);
      }
      db.setSettings(kv);
      return parseSettingsKV(db.getSettings());
    }),
});

// ---------------------------------------------------------------------------
// cameras.*
// ---------------------------------------------------------------------------

const camerasRouter = router({
  // List + last_frame_at per camera. Lookup via frigate.getCameraStats is best-
  // effort: if Frigate isn't reachable, lastFrameAt is null and the frontend
  // renders the napping/offline state — exactly the desired degradation.
  list: protectedProcedure
    .input(z.void())
    .output(z.array(cameraSchema))
    .query(async () => {
      const rows = db.listCameras();
      return Promise.all(
        rows.map(async (row): Promise<CameraDTO> => {
          let lastFrameAt: number | null = null;
          try {
            const stats = await frigate.getCameraStats(row.name);
            lastFrameAt = stats.lastFrameAt;
          } catch {
            lastFrameAt = null;
          }
          return cameraToDTO(row, lastFrameAt);
        }),
      );
    }),

  create: adminProcedure
    .meta({
      audit: {
        action: 'cameras.create',
        targetType: 'camera',
        // Newly-created row id only exists post-mutation, so read from result.
        targetIdFromResult: (result) =>
          isRecord(result) && typeof result['id'] === 'number' ? result['id'] : null,
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          return {
            name: input['name'],
            emoji: input['emoji'],
            stream_url: input['stream_url'],
            enabled: input['enabled'],
          };
        },
      },
    })
    .input(z.object({
      name: z.string().min(1).max(60),
      emoji: z.string().max(8).default('📷'),
      stream_url: z.string().min(1),
      enabled: z.boolean().default(true),
    }))
    .output(cameraSchema)
    .mutation(({ input }) => {
      const row = db.createCamera({
        name: input.name,
        emoji: input.emoji,
        stream_url: input.stream_url,
        enabled: input.enabled,
      });
      return cameraToDTO(row, null);
    }),

  update: adminProcedure
    .meta({
      audit: {
        action: 'cameras.update',
        targetType: 'camera',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(z.object({
      id: z.number().int(),
      name: z.string().min(1).max(60),
      emoji: z.string().max(8),
      stream_url: z.string().min(1),
      enabled: z.boolean(),
    }))
    .output(cameraSchema)
    .mutation(({ ctx, input }) => {
      const before = db.getCameraById(input.id);
      if (before) ctx.audit['before'] = cameraToDTO(before, null);
      const row = db.updateCamera(input);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'camera not found' });
      return cameraToDTO(row, null);
    }),

  delete: adminProcedure
    .meta({
      audit: {
        action: 'cameras.delete',
        targetType: 'camera',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        // Capture the deleted row's identity so the audit reviewer can see
        // what was removed (the row itself is gone by the time they look).
        detailsFrom: (_input, _result, ctx) => {
          const before = ctx.audit['before'];
          if (!isRecord(before)) return null;
          return { name: before['name'], stream_url: before['stream_url'] };
        },
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const before = db.getCameraById(input.id);
      if (before) ctx.audit['before'] = cameraToDTO(before, null);
      db.deleteCamera(input.id);
      return { ok: true } as const;
    }),

  reorder: adminProcedure
    .meta({
      audit: {
        action: 'cameras.reorder',
        targetType: 'camera',
        // Reorder hits every row — no single target_id is meaningful, so we
        // surface the ordered list as the audit-detail payload instead.
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          const ids = input['ordered_ids'];
          return Array.isArray(ids) ? { ordered_ids: ids } : null;
        },
      },
    })
    .input(z.object({ ordered_ids: z.array(z.number().int()).min(1) }))
    .output(z.array(cameraSchema))
    .mutation(({ input }) => {
      db.reorderCameras(input.ordered_ids);
      return db.listCameras().map((row) => cameraToDTO(row, null));
    }),

  // Proxied helpers — Frigate-dependent, Stage 2a fills them in.
  discover: adminProcedure
    .meta({ audit: false })
    .input(z.void())
    .output(z.array(z.object({ name: z.string(), stream_url: z.string() })))
    .query(async () => {
      const found = await frigate.discoverCameras();
      return found.map((c) => ({ name: c.name, stream_url: c.stream_url }));
    }),

  testStream: adminProcedure
    .meta({ audit: false })
    .input(z.object({ stream_url: z.string().min(1) }))
    .output(z.object({ ok: z.boolean(), status: z.number().int().nullable() }))
    .mutation(({ input }) => frigate.testStream(input.stream_url)),
});

// ---------------------------------------------------------------------------
// activity.*
// ---------------------------------------------------------------------------

const activityRouter = router({
  today: protectedProcedure
    .input(z.void())
    .output(z.array(diaryEntrySchema))
    .query(() => {
      const start = startOfLocalDay(new Date());
      const end = start + 24 * 60 * 60 * 1000;
      return db.listDiaryEntriesBetween(start, end).map(diaryToDTO);
    }),

  // Manual "Take a photo!" from the maximized view. Returns the diary entry
  // the frontend renders inline.
  snapshot: protectedProcedure
    .input(z.object({ camera_id: z.number().int() }))
    .output(diaryEntrySchema)
    .mutation(async ({ input }) => {
      const camera = db.getCameraById(input.camera_id);
      if (!camera) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'camera not found' });
      }
      const now = Date.now();
      // Frigate exposes a `latest.jpg` for any tracked camera; we cache that
      // image into STORAGE_PATH/snapshots/<camera>-<ts>.jpg. The file write is
      // best-effort: if Frigate isn't reachable we still record the diary
      // row with an empty media_path so the timestamp lands in the day's
      // feed.
      const mediaRel = await frigate.captureLatestSnapshot(camera.name, now);
      const entry = await saveManualSnapshot({
        cameraId: camera.id,
        takenAt: now,
        mediaPath: mediaRel,
      });
      return diaryToDTO(entry);
    }),

  // Admin-only debugging view: the in-memory ring buffer the narrator keeps
  // for tuning TRANSITION_WINDOW_MS / MIN_DWELL_MS.
  recentEvents: adminProcedure
    .meta({ audit: false })
    .input(z.void())
    .output(z.array(z.object({
      camera: z.string(),
      label: z.string(),
      zone: z.string().nullable(),
      type: z.enum(['new', 'update', 'end']),
      at: z.number().int(),
    })))
    .query(() => getRecentEvents()),
});

// ---------------------------------------------------------------------------
// stats.*
// ---------------------------------------------------------------------------

const statsRouter = router({
  today: protectedProcedure
    .input(z.void())
    .output(z.object({
      wheel_ms: z.number().int().nonnegative(),
      snack_visits: z.number().int().nonnegative(),
      restful_ratio: z.number().min(0).max(1),
    }))
    .query(() => {
      const start = startOfLocalDay(new Date());
      const end = start + 24 * 60 * 60 * 1000;
      const entries = db.listDiaryEntriesBetween(start, end);
      let wheelMs = 0;
      let snackVisits = 0;
      let restfulMs = 0;
      let activeMs = 0;
      for (const e of entries) {
        const dur = e.duration_ms ?? 0;
        if (e.activity === 'wheel') wheelMs += dur;
        if (e.activity === 'food') snackVisits += 1;
        if (e.activity === 'resting') restfulMs += dur;
        if (e.activity && e.activity !== 'snapshot' && e.activity !== 'timelapse') {
          activeMs += dur;
        }
      }
      const restfulRatio = activeMs > 0 ? Math.min(1, restfulMs / activeMs) : 0;
      return {
        wheel_ms: wheelMs,
        snack_visits: snackVisits,
        restful_ratio: restfulRatio,
      };
    }),
});

// ---------------------------------------------------------------------------
// badges.*
// ---------------------------------------------------------------------------

const badgesRouter = router({
  earned: protectedProcedure
    .input(z.void())
    .output(z.array(badgeSchema))
    .query(() => db.listBadges()),
});

// ---------------------------------------------------------------------------
// users.*
// ---------------------------------------------------------------------------

const usersRouter = router({
  list: adminProcedure
    .meta({ audit: false })
    .input(z.void())
    .output(z.array(publicUserSchema))
    .query(() => db.listUsers().map((u) => db.toPublicUser(u))),

  create: adminProcedure
    .meta({
      audit: {
        action: 'users.create',
        targetType: 'user',
        // New user's id is the row we just inserted — only known post-mutation.
        targetIdFromResult: (result) =>
          isRecord(result) && typeof result['id'] === 'number' ? result['id'] : null,
        // Record the new user's email + display_name + role (NOT password, which
        // never reaches the audit table either way — it's not in the result).
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          return {
            email: input['email'],
            display_name: input['display_name'],
            role: input['role'],
          };
        },
      },
    })
    .input(z.object({
      email: z.string().email(),
      display_name: z.string().min(1).max(40),
      password: z.string().min(6),
      role: roleSchema,
    }))
    .output(publicUserSchema)
    .mutation(async ({ ctx, input }) => {
      // Atomic semantics: Zyphr-register first; only insert the local row on
      // a 2xx upstream response. Atomicity contract is here at Stage 1 so the
      // Stage 2a implementation has nowhere to drift.
      let registered;
      try {
        registered = await registerAccount(input.email, input.password, input.display_name);
      } catch (err) {
        if (err instanceof ZyphrEmailTaken) {
          throw new TRPCError({ code: 'CONFLICT', message: 'email already registered' });
        }
        throw err;
      }
      const row = db.createUser({
        zyphr_user_id: registered.zyphr_user_id,
        email: input.email,
        display_name: input.display_name,
        role: input.role,
        created_by: ctx.user.id,
      });
      return db.toPublicUser(row);
    }),

  update: adminProcedure
    .meta({
      audit: {
        action: 'users.update',
        targetType: 'user',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(z.object({
      id: z.number().int(),
      display_name: z.string().min(1).max(40),
      role: roleSchema,
    }))
    .output(publicUserSchema)
    .mutation(({ ctx, input }) => {
      const target = db.getUserById(input.id);
      if (!target) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      }
      // Refuse to demote the last remaining admin.
      if (target.role === 'admin' && input.role !== 'admin') {
        if (db.countAdmins() <= 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'cannot demote the last remaining admin',
          });
        }
      }
      // Snapshot the pre-update public projection for the audit diff.
      ctx.audit['before'] = db.toPublicUser(target);
      const row = db.updateUser(input);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      // Defense-in-depth (Security-Review out-of-band recommendation): when
      // role changes, kill any active sessions for the affected user so a
      // promoted child / demoted admin doesn't keep the old in-memory role
      // until session expiry. requireAdmin re-checks role per-request via
      // db.getUserById, but rotation closes the window where an existing
      // session object's cached `user.role` would be stale.
      if (target.role !== row.role) {
        db.deleteSessionsForUser(row.id);
      }
      return db.toPublicUser(row);
    }),

  delete: adminProcedure
    .meta({
      audit: {
        action: 'users.delete',
        targetType: 'user',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        // Audit reviewer needs the deleted user's email/display_name — the
        // row itself is gone by the time they read the log.
        detailsFrom: (_input, _result, ctx) => {
          const before = ctx.audit['before'];
          if (!isRecord(before)) return null;
          return {
            email: before['email'],
            display_name: before['display_name'],
            role: before['role'],
          };
        },
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const target = db.getUserById(input.id);
      if (!target) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      }
      if (target.role === 'admin' && db.countAdmins() <= 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'cannot delete the last remaining admin',
        });
      }
      if (target.id === ctx.user.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'cannot delete your own account from this UI; sign in as another admin first',
        });
      }
      ctx.audit['before'] = db.toPublicUser(target);
      db.deleteUser(input.id);
      return { ok: true } as const;
    }),

  resetPassword: adminProcedure
    .meta({
      audit: {
        action: 'users.resetPassword',
        targetType: 'user',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ input }) => {
      const target = db.getUserById(input.id);
      if (!target) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      }
      await triggerForgotPassword(target.email);
      return { ok: true } as const;
    }),

  changeOwnPassword: protectedProcedure
    .input(z.void())
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      await triggerForgotPassword(ctx.user.email);
      return { ok: true } as const;
    }),
});

// ---------------------------------------------------------------------------
// audit.*
// ---------------------------------------------------------------------------

const auditRouter = router({
  list: adminProcedure
    .meta({ audit: false })
    .input(z.object({
      cursor: z.number().int().nullable().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      actor_user_id: z.number().int().nullable().optional(),
      action_prefix: z.string().nullable().optional(),
      since: z.number().int().nullable().optional(),
      until: z.number().int().nullable().optional(),
    }))
    .output(z.object({
      items: z.array(auditLogSchema),
      next_cursor: z.number().int().nullable(),
    }))
    .query(({ input }) => {
      const items = db.listAudit({
        cursor: input.cursor ?? null,
        limit: input.limit,
        actor_user_id: input.actor_user_id ?? null,
        action_prefix: input.action_prefix ?? null,
        since: input.since ?? null,
        until: input.until ?? null,
      });
      const lastItem = items.length === input.limit ? items[items.length - 1] : null;
      const nextCursor = lastItem ? lastItem.id : null;
      return { items, next_cursor: nextCursor };
    }),
});

// ---------------------------------------------------------------------------
// recipients.*  (Send-a-Clip allowlist)
// ---------------------------------------------------------------------------

const recipientsRouter = router({
  list: protectedProcedure
    .input(z.void())
    .output(z.array(recipientSchema))
    .query(() => db.listShareRecipients()),

  create: adminProcedure
    .meta({
      audit: {
        action: 'recipients.create',
        targetType: 'recipient',
        targetIdFromResult: (result) =>
          isRecord(result) && typeof result['id'] === 'number' ? result['id'] : null,
        detailsFrom: (input) => {
          if (!isRecord(input)) return null;
          return { display_name: input['display_name'], email: input['email'] };
        },
      },
    })
    .input(z.object({
      display_name: z.string().min(1).max(40),
      email: z.string().email(),
    }))
    .output(recipientSchema)
    .mutation(({ ctx, input }) => db.createShareRecipient({
      display_name: input.display_name,
      email: input.email,
      added_by: ctx.user.id,
    })),

  update: adminProcedure
    .meta({
      audit: {
        action: 'recipients.update',
        targetType: 'recipient',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, result, ctx) => {
          const before = ctx.audit['before'];
          return diffObjects(
            isRecord(before) ? before : {},
            isRecord(result) ? result : {},
          );
        },
      },
    })
    .input(z.object({
      id: z.number().int(),
      display_name: z.string().min(1).max(40),
      email: z.string().email(),
    }))
    .output(recipientSchema)
    .mutation(({ ctx, input }) => {
      const before = db.getShareRecipientById(input.id);
      if (before) ctx.audit['before'] = before;
      const row = db.updateShareRecipient(input);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'recipient not found' });
      return row;
    }),

  delete: adminProcedure
    .meta({
      audit: {
        action: 'recipients.delete',
        targetType: 'recipient',
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['id'] === 'number' ? input['id'] : null,
        detailsFrom: (_input, _result, ctx) => {
          const before = ctx.audit['before'];
          if (!isRecord(before)) return null;
          return { display_name: before['display_name'], email: before['email'] };
        },
      },
    })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const before = db.getShareRecipientById(input.id);
      if (before) ctx.audit['before'] = before;
      db.deleteShareRecipient(input.id);
      return { ok: true } as const;
    }),
});

// ---------------------------------------------------------------------------
// share.*
// ---------------------------------------------------------------------------

const shareRouter = router({
  send: protectedProcedure
    .input(z.object({
      diary_entry_id: z.number().int(),
      recipient_id: z.number().int(),
    }))
    .output(shareLogSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await startShareJob({
        userId: ctx.user.id,
        recipientId: input.recipient_id,
        diaryEntryId: input.diary_entry_id,
      });
      return row;
    }),

  /** Live status of a previously-queued send. Polled by the frontend. */
  status: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .output(shareLogSchema.nullable())
    .query(({ ctx, input }) => {
      const row = db.getShareLogById(input.id);
      if (!row) return null;
      // A user can only see their own share-log entries; admins see all.
      if (ctx.user.role !== 'admin' && row.user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'forbidden' });
      }
      return row;
    }),

  listMine: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .output(z.array(shareLogSchema))
    .query(({ ctx, input }) => db.listShareLogForUser(ctx.user.id, input.limit)),
});

// ---------------------------------------------------------------------------
// admin.* — manual job triggers (Audit tab actions)
// ---------------------------------------------------------------------------

const adminRouter = router({
  rebuildTimelapse: adminProcedure
    .meta({
      audit: {
        action: 'admin.rebuildTimelapse',
        targetType: 'job',
        // Date string is the natural target — there's no row id for "the job".
        targetIdFrom: (input) =>
          isRecord(input) && typeof input['date'] === 'string' ? input['date'] : null,
        detailsFrom: (_input, result) => (isRecord(result) ? result : null),
      },
    })
    .input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .output(z.object({
      date: z.string(),
      produced: z.boolean(),
      media_path: z.string().nullable(),
      diary_entry_id: z.number().int().nullable(),
    }))
    .mutation(({ input }) => runTimelapseJob(new Date(`${input.date}T12:00:00`))),

  runRetention: adminProcedure
    .meta({
      audit: {
        action: 'admin.runRetention',
        targetType: 'job',
        detailsFrom: (_input, result) => (isRecord(result) ? result : null),
      },
    })
    .input(z.void())
    .output(z.object({
      snapshots_deleted: z.number().int().nonnegative(),
      timelapse_media_cleared: z.number().int().nonnegative(),
      audit_rows_deleted: z.number().int().nonnegative(),
    }))
    .mutation(() => runRetentionJob()),

  runDiskWatch: adminProcedure
    .meta({
      audit: {
        action: 'admin.runDiskWatch',
        targetType: 'job',
        detailsFrom: (_input, result) => (isRecord(result) ? result : null),
      },
    })
    .input(z.void())
    .output(z.object({
      severity: z.enum(['ok', 'warn', 'critical']),
      pct_used: z.number(),
      free_gb: z.number(),
      alerted: z.boolean(),
    }))
    .mutation(() => runDiskWatchJob()),
});

// ---------------------------------------------------------------------------
// App router — frozen surface
// ---------------------------------------------------------------------------

export const appRouter = router({
  settings: settingsRouter,
  cameras: camerasRouter,
  activity: activityRouter,
  stats: statsRouter,
  badges: badgesRouter,
  users: usersRouter,
  audit: auditRouter,
  recipients: recipientsRouter,
  share: shareRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function startOfLocalDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/** Narrow `unknown` to a plain object so audit resolvers can read fields safely. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Shallow before/after diff for update-shape audit details. Returns
 *   { changed: { key: { before, after }, … } }
 * containing only the keys whose values differ (compared via JSON.stringify
 * so nested objects + arrays compare structurally). Keys present in one
 * object but not the other are also reported.
 *
 * The audit-log `details` column is meant for humans skimming a forensic
 * trail — concise is more valuable than exhaustive.
 */
function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { changed: Record<string, { before: unknown; after: unknown }> } {
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    // Structural compare via JSON; both sides are plain JSON-shaped already
    // (DTOs / settings KV / public users).
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed[k] = { before: a, after: b };
    }
  }
  return { changed };
}
