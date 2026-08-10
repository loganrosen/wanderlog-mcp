import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { addCarRental } from "../../src/tools/add-car-rental.ts";
import { addTransit } from "../../src/tools/add-transit.ts";
import { createTrip } from "../../src/tools/create-trip.ts";

/**
 * End-to-end round trip for the transit and rental-car tools. Creates a
 * throwaway trip, exercises add_transit (ferry + bus sharing one section)
 * and add_car_rental, then deletes the trip. Runs against the live
 * Wanderlog API.
 *
 * If this test leaves a stray trip behind (e.g. crash mid-run), it'll
 * show up in wanderlog.com labeled "WANDERDOG_TEST_<timestamp>" — delete
 * it manually.
 */
describe("Transit & rental-car tools (live round-trip)", () => {
  let ctx: AppContext;
  let tripKey: string | undefined;

  beforeAll(async () => {
    if (!process.env.WANDERLOG_COOKIE) {
      throw new Error("WANDERLOG_COOKIE must be set");
    }
    ctx = createContext();
    const user = await ctx.rest.getUser();
    ctx.userId = user.id;

    const result = await createTrip(ctx, {
      destination: "Guadeloupe",
      start_date: "2099-01-01",
      end_date: "2099-01-10",
      title: `WANDERDOG_TEST_${Date.now()}`,
      privacy: "private",
    });
    if (result.isError) {
      throw new Error(`create_trip failed: ${result.content[0]!.text}`);
    }
    const keyMatch = /Key: (\w+)/.exec(result.content[0]!.text);
    expect(keyMatch).not.toBeNull();
    tripKey = keyMatch![1]!;
  }, 30_000);

  afterAll(async () => {
    ctx?.pool.closeAll();
    if (tripKey) {
      try {
        await ctx.rest.deleteTrip(tripKey);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("adds a ferry and a bus into a shared transit section", async () => {
    expect(tripKey).toBeDefined();
    const ferry = await addTransit(ctx, {
      trip_key: tripKey!,
      type: "ferry",
      carrier: "Test Ferry Line",
      from: "Trois-Rivières",
      to: "Terre-de-Haut",
      depart_date: "2099-01-02",
      depart_time: "09:00",
      arrive_date: "2099-01-02",
      arrive_time: "10:00",
      confirmation_number: "FERRY-1",
    });
    if (ferry.isError) {
      throw new Error(`add_transit(ferry) failed: ${ferry.content[0]!.text}`);
    }

    const bus = await addTransit(ctx, {
      trip_key: tripKey!,
      type: "bus",
      carrier: "Test Bus Co",
      from: "Saint-François",
      to: "Sainte-Anne",
      depart_date: "2099-01-03",
      depart_time: "14:00",
      arrive_date: "2099-01-03",
      arrive_time: "14:45",
    });
    if (bus.isError) {
      throw new Error(`add_transit(bus) failed: ${bus.content[0]!.text}`);
    }

    const trip = await ctx.tripCache.get(tripKey!);
    const transitSections = trip.itinerary.sections.filter((s) => s.type === "transit");
    expect(transitSections).toHaveLength(1);
    const types = transitSections[0]!.blocks.map((b) => b.type).sort();
    expect(types).toEqual(["bus", "ferry"]);
  }, 30_000);

  it("adds a rental car into a rentalCars section", async () => {
    expect(tripKey).toBeDefined();
    const car = await addCarRental(ctx, {
      trip_key: tripKey!,
      pickup_location: "Pointe-à-Pitre Airport",
      pickup_date: "2099-01-01",
      pickup_time: "10:00",
      dropoff_location: "Pointe-à-Pitre Airport",
      dropoff_date: "2099-01-10",
      dropoff_time: "10:00",
      confirmation_number: "CAR-1",
    });
    if (car.isError) {
      throw new Error(`add_car_rental failed: ${car.content[0]!.text}`);
    }

    const trip = await ctx.tripCache.get(tripKey!);
    const rental = trip.itinerary.sections.find((s) => s.type === "rentalCars");
    expect(rental).toBeDefined();
    expect(rental!.blocks.some((b) => b.type === "rentalCar")).toBe(true);
  }, 30_000);

  it("rejects an arrival before departure without mutating the trip", async () => {
    expect(tripKey).toBeDefined();
    const before = await ctx.tripCache.get(tripKey!);
    const beforeCount =
      before.itinerary.sections.find((s) => s.type === "transit")?.blocks.length ?? 0;

    const bad = await addTransit(ctx, {
      trip_key: tripKey!,
      type: "train",
      carrier: "X",
      from: "Saint-François",
      to: "Sainte-Anne",
      depart_date: "2099-01-04",
      depart_time: "12:00",
      arrive_date: "2099-01-04",
      arrive_time: "11:00",
    });
    expect(bad.isError).toBe(true);

    const after = await ctx.tripCache.get(tripKey!);
    const afterCount =
      after.itinerary.sections.find((s) => s.type === "transit")?.blocks.length ?? 0;
    expect(afterCount).toBe(beforeCount);
  }, 20_000);
});
