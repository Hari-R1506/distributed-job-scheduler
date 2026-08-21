import { Client } from 'pg';
import { JOBS_READY_CHANNEL } from '@djs/db';

export interface NotifyListenerOptions {
  databaseUrl: string;
  onNotify: (queueId: string) => void;
  onError?: (err: unknown) => void;
  reconnectMs?: number;
}

/**
 * Wakes the claim loop the moment work arrives.
 *
 * ⚠️ The connection is DEDICATED and unpooled. A pooled connection is reset
 * between checkouts, which silently drops the LISTEN subscription — a bug that
 * presents as "notifications work in dev and stop working under load", which is
 * miserable to debug during a demo.
 *
 * This is purely a latency optimisation. The worker's jittered poll timer is
 * the correctness guarantee: if every notification were lost, the system would
 * still process everything, just with up to one poll interval of delay. That is
 * the right way round, and it is why we do not need delivery guarantees from
 * NOTIFY (which offers none — messages sent while disconnected are gone).
 */
export async function startNotifyListener(
  opts: NotifyListenerOptions,
): Promise<() => Promise<void>> {
  const reconnectMs = opts.reconnectMs ?? 2_000;
  let client: Client | undefined;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      client = new Client({ connectionString: opts.databaseUrl });
      client.on('error', (err) => {
        opts.onError?.(err);
        scheduleReconnect();
      });
      client.on('notification', (msg) => {
        if (msg.channel === JOBS_READY_CHANNEL && msg.payload) opts.onNotify(msg.payload);
      });
      await client.connect();
      await client.query(`LISTEN ${JOBS_READY_CHANNEL}`);
    } catch (err) {
      opts.onError?.(err);
      scheduleReconnect();
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    void client?.end().catch(() => {});
    client = undefined;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, reconnectMs);
    reconnectTimer.unref?.();
  };

  await connect();

  return async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    client?.removeAllListeners();
    await client?.end().catch(() => {});
  };
}
