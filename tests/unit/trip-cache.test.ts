import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TripCache } from "../../src/cache/trip-cache.ts";
import type { AppContext } from "../../src/context.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import { submitOp } from "../../src/tools/shared.ts";
import type { RestClient } from "../../src/transport/rest.ts";
import type { ShareDBClient, ShareDBPool } from "../../src/transport/sharedb.ts";

class FakeShareDBClient extends EventEmitter {
  public isSubscribed = false;
  public subscribeCalled = 0;
  public submitCalled = 0;
  public closeCalled = 0;
  public closeDuringSubscribe = false;

  constructor(
    public version: number,
    private readonly title: string,
  ) {
    super();
  }

  async subscribe() {
    this.subscribeCalled++;
    this.isSubscribed = true;
    if (this.closeDuringSubscribe) this.isSubscribed = false;
    return {
      title: this.title,
      itinerary: { sections: [] },
    };
  }

  async submit(_ops: Json0Op[]): Promise<void> {
    if (!this.isSubscribed) throw new Error("not subscribed");
    this.submitCalled++;
    this.version++;
  }

  disconnect(code = 1000): void {
    this.isSubscribed = false;
    this.emit("closed", code);
  }

  close(): void {
    this.closeCalled++;
    this.isSubscribed = false;
  }
}

class FakeShareDBPool {
  public readonly created = new Map<string, FakeShareDBClient[]>();
  private readonly clients = new Map<string, FakeShareDBClient>();

  get(tripKey: string): FakeShareDBClient {
    let client = this.clients.get(tripKey);
    if (!client) {
      const tripClients = this.created.get(tripKey) ?? [];
      const sequence = tripClients.length + 1;
      client = new FakeShareDBClient(sequence * 10, `${tripKey} snapshot ${sequence}`);
      tripClients.push(client);
      this.created.set(tripKey, tripClients);
      this.clients.set(tripKey, client);
    }
    return client;
  }

  evict(tripKey: string, expectedClient?: ShareDBClient): boolean {
    const client = this.clients.get(tripKey);
    if (!client || (expectedClient && client !== expectedClient)) return false;
    this.clients.delete(tripKey);
    client.close();
    return true;
  }

  has(tripKey: string): boolean {
    return this.clients.has(tripKey);
  }
}

function makeCache(): {
  cache: TripCache;
  pool: FakeShareDBPool;
  getTripCalls: () => number;
} {
  let getTripCalls = 0;
  const rest = {
    getTripWithResources: async () => {
      getTripCalls++;
      return { geos: [] };
    },
  } as unknown as RestClient;
  const pool = new FakeShareDBPool();
  return {
    cache: new TripCache(rest, pool as unknown as ShareDBPool),
    pool,
    getTripCalls: () => getTripCalls,
  };
}

describe("TripCache subscription lifecycle", () => {
  it("unregisters client listeners and evicts the client on invalidate", async () => {
    const { cache, pool } = makeCache();

    await cache.get("tripA");
    const client = pool.created.get("tripA")![0]!;
    expect(client.listenerCount("remoteOp")).toBe(1);
    expect(client.listenerCount("closed")).toBe(1);

    cache.invalidate("tripA");

    expect(client.listenerCount("remoteOp")).toBe(0);
    expect(client.listenerCount("closed")).toBe(0);
    expect(client.closeCalled).toBe(1);
    expect(pool.has("tripA")).toBe(false);
  });

  it("recovers from a normal close with a fresh client and snapshot", async () => {
    const { cache, pool, getTripCalls } = makeCache();
    const first = await cache.getEntry("tripA");
    const firstClient = pool.created.get("tripA")![0]!;

    firstClient.disconnect(1000);

    expect(firstClient.listenerCount("remoteOp")).toBe(0);
    expect(firstClient.listenerCount("closed")).toBe(0);
    expect(pool.has("tripA")).toBe(false);

    const second = await cache.getEntry("tripA");
    const secondClient = pool.created.get("tripA")![1]!;
    expect(second.snapshot.title).toBe("tripA snapshot 2");
    expect(second.version).toBe(20);
    expect(secondClient).not.toBe(firstClient);
    expect(secondClient.subscribeCalled).toBe(1);
    expect(getTripCalls()).toBe(2);
  });

  it("uses the same lazy recovery path after an abnormal close", async () => {
    const { cache, pool } = makeCache();
    await cache.get("tripA");
    const firstClient = pool.created.get("tripA")![0]!;

    firstClient.disconnect(1006);

    expect(pool.has("tripA")).toBe(false);
    expect(firstClient.closeCalled).toBe(1);
    const trip = await cache.get("tripA");
    expect(trip.title).toBe("tripA snapshot 2");
  });

  it("recovers the next mutation after a close races an earlier submit", async () => {
    const { cache, pool } = makeCache();
    const ctx = {
      pool: pool as unknown as ShareDBPool,
      tripCache: cache,
    } as AppContext;
    const first = await cache.getEntry("tripA");
    const firstClient = pool.created.get("tripA")![0]!;
    const staleOps: Json0Op[] = [
      {
        p: ["title"],
        od: first.snapshot.title,
        oi: "stale mutation",
      },
    ];

    firstClient.disconnect(1000);

    await expect(submitOp(ctx, "tripA", staleOps)).rejects.toMatchObject({
      code: "not_subscribed",
    });

    const fresh = await cache.getEntry("tripA");
    const freshClient = pool.created.get("tripA")![2]!;
    const freshOps: Json0Op[] = [
      {
        p: ["title"],
        od: fresh.snapshot.title,
        oi: "recovered mutation",
      },
    ];
    await submitOp(ctx, "tripA", freshOps);

    expect(freshClient.submitCalled).toBe(1);
    expect((await cache.get("tripA")).title).toBe("recovered mutation");
  });

  it("replaces an unsubscribed entry even when no close event was observed", async () => {
    const { cache, pool } = makeCache();
    await cache.get("tripA");
    const firstClient = pool.created.get("tripA")![0]!;
    firstClient.isSubscribed = false;

    const trip = await cache.get("tripA");

    expect(trip.title).toBe("tripA snapshot 2");
    expect(firstClient.closeCalled).toBe(1);
    expect(pool.created.get("tripA")).toHaveLength(2);
  });

  it("does not publish a snapshot if the subscription closes before caching", async () => {
    const { cache, pool } = makeCache();
    const client = pool.get("tripA");
    client.closeDuringSubscribe = true;

    await expect(cache.get("tripA")).rejects.toMatchObject({ code: "ws_closed" });
    expect(client.listenerCount("remoteOp")).toBe(0);
    expect(client.listenerCount("closed")).toBe(0);
    expect(client.closeCalled).toBe(1);
    expect(pool.has("tripA")).toBe(false);
  });

  it("handles repeated subscribe and invalidate cycles without leaking listeners", async () => {
    const { cache, pool } = makeCache();

    for (let i = 0; i < 5; i++) {
      await cache.get("tripA");
      const client = pool.created.get("tripA")![i]!;
      expect(client.listenerCount("remoteOp")).toBe(1);
      expect(client.listenerCount("closed")).toBe(1);
      cache.invalidate("tripA");
      expect(client.listenerCount("remoteOp")).toBe(0);
      expect(client.listenerCount("closed")).toBe(0);
    }
  });

  it("unregisters listeners and evicts every cached client on clear", async () => {
    const { cache, pool } = makeCache();
    await cache.get("tripA");
    await cache.get("tripB");
    const clientA = pool.created.get("tripA")![0]!;
    const clientB = pool.created.get("tripB")![0]!;

    cache.clear();

    for (const client of [clientA, clientB]) {
      expect(client.listenerCount("remoteOp")).toBe(0);
      expect(client.listenerCount("closed")).toBe(0);
      expect(client.closeCalled).toBe(1);
    }
    expect(pool.has("tripA")).toBe(false);
    expect(pool.has("tripB")).toBe(false);
  });
});
