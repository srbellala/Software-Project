/**
 * /api/fit/* wrappers: kick off a fit run and stream its progress via SSE
 * (matches api/fit_routes.py's POST /run + GET /progress).
 */

export type FitParams = Record<string, number>;

export interface FitRunBody {
  modality: "T2" | "T1";
  params: FitParams;
  tr_ms: number | null;
}

export async function startFit(sid: string, body: FitRunBody): Promise<void> {
  const r = await fetch(`/api/fit/${sid}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Fit start failed");
}

export type FitProgressMsg =
  | { status: "progress"; pct: number; done: number; total: number; eta_seconds?: number }
  | { status: "done" }
  | { status: "error"; message?: string }
  | { status: "heartbeat" };

export interface FitProgressHandlers {
  onProgress: (pct: number, done: number, total: number, etaSeconds?: number) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/** Returns a close() function; callers should invoke it if they unmount mid-stream. */
export function subscribeFitProgress(sid: string, handlers: FitProgressHandlers): () => void {
  const es = new EventSource(`/api/fit/${sid}/progress`);
  es.onmessage = (e) => {
    const msg: FitProgressMsg = JSON.parse(e.data);
    if (msg.status === "progress") {
      handlers.onProgress(msg.pct, msg.done, msg.total, msg.eta_seconds);
    } else if (msg.status === "done") {
      es.close();
      handlers.onDone();
    } else if (msg.status === "error") {
      es.close();
      handlers.onError(msg.message || "");
    }
  };
  es.onerror = () => {
    es.close();
    handlers.onError("SSE connection lost");
  };
  return () => es.close();
}
