import { describe, expect, it } from "vitest";
import {
  buildTransitBlock,
  buildRentalCarBlock,
  sectionInsertOp,
  validateChronology,
} from "../../src/tools/shared.ts";
import { applyOp } from "../../src/ot/apply.ts";
import type { PlaceData, TripPlan } from "../../src/types.ts";
import { WanderlogValidationError } from "../../src/errors.ts";

const place = (name: string): PlaceData => ({ name, place_id: `pid_${name}` });
const ep = (name: string) => ({ place: place(name), date: "2026-11-08", time: "09:00" });

describe("buildTransitBlock", () => {
  it("builds a ferry with the confirmed shape", () => {
    const b = buildTransitBlock("ferry", 42, {
      carrier: "CTM DEHER",
      depart: ep("A"),
      arrive: { ...ep("B"), time: "10:00" },
      confirmationNumber: "X1",
      notes: "deck 2",
    }) as Record<string, unknown>;
    expect(b.type).toBe("ferry");
    expect(b.carrier).toBe("CTM DEHER");
    expect(b.addedBy).toEqual({ type: "user", userId: 42 });
    expect(b.attachments).toEqual([]);
    expect(b.text).toEqual({ ops: [{ insert: "deck 2\n" }] });
    expect(b.confirmationNumber).toBe("X1");
    expect("travelerNames" in b).toBe(false);
    expect(JSON.stringify(b).includes("airportOrGeo")).toBe(false);
  });

  it("omits confirmationNumber and uses bare newline when notes absent", () => {
    const b = buildTransitBlock("bus", 1, {
      carrier: "FlixBus",
      depart: ep("A"),
      arrive: ep("B"),
    }) as Record<string, unknown>;
    expect(b.text).toEqual({ ops: [{ insert: "\n" }] });
    expect("confirmationNumber" in b).toBe(false);
  });

  it("includes travelerNames only when non-empty", () => {
    const withNames = buildTransitBlock("train", 1, {
      carrier: "SNCF",
      depart: ep("A"),
      arrive: ep("B"),
      travelerNames: ["Jo"],
    }) as Record<string, unknown>;
    expect(withNames.travelerNames).toEqual(["Jo"]);
    const without = buildTransitBlock("train", 1, {
      carrier: "SNCF",
      depart: ep("A"),
      arrive: ep("B"),
      travelerNames: [],
    }) as Record<string, unknown>;
    expect("travelerNames" in without).toBe(false);
  });
});

describe("buildRentalCarBlock", () => {
  it("builds a rentalCar with pickUp/dropOff and no carrier/airportOrGeo", () => {
    const b = buildRentalCarBlock(7, {
      pickUp: { date: "2026-11-01", time: "10:00", place: place("Europcar CUN") },
      dropOff: { date: "2026-11-08", time: "13:00", place: place("Europcar PDC") },
      confirmationNumber: "C9",
    }) as Record<string, unknown>;
    expect(b.type).toBe("rentalCar");
    expect((b.pickUp as { place: PlaceData }).place.name).toBe("Europcar CUN");
    expect(b.confirmationNumber).toBe("C9");
    expect("carrier" in b).toBe(false);
    expect(JSON.stringify(b).includes("airportOrGeo")).toBe(false);
  });
});

describe("sectionInsertOp", () => {
  const base = (): TripPlan =>
    ({
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Places to visit",
            date: null,
            blocks: [],
          },
        ],
      },
    }) as unknown as TripPlan;

  it("creates a transit section when none exists and the block round-trips", () => {
    const trip = base();
    const block = buildTransitBlock("ferry", 1, { carrier: "C", depart: ep("A"), arrive: ep("B") });
    const op = sectionInsertOp(trip, "transit", block);
    const next = applyOp(trip, [op]);
    const sec = next.itinerary.sections.find((s) => s.type === "transit")!;
    expect(sec.heading).toBe("Transit");
    expect(sec.placeMarkerIcon).toBe("subway");
    expect(sec.placeMarkerColor).toBe("#17b978");
    expect(sec.blocks).toHaveLength(1);
    expect(sec.blocks[0]!.type).toBe("ferry");
  });

  it("appends to an existing rentalCars section", () => {
    const trip = base();
    trip.itinerary.sections.push({
      id: 9,
      type: "rentalCars",
      mode: "placeList",
      heading: "Rental cars",
      date: null,
      blocks: [{ id: 100, type: "rentalCar" }],
    } as never);
    const block = buildRentalCarBlock(1, {
      pickUp: { date: "2026-11-01", time: "10:00", place: place("X") },
      dropOff: { date: "2026-11-02", time: "10:00", place: place("Y") },
    });
    const op = sectionInsertOp(trip, "rentalCars", block);
    const next = applyOp(trip, [op]);
    const sec = next.itinerary.sections.find((s) => s.type === "rentalCars")!;
    expect(sec.blocks).toHaveLength(2);
  });
});

describe("validateChronology", () => {
  it("accepts an overnight leg (22:00 day1 -> 06:00 day2)", () => {
    expect(() =>
      validateChronology("depart", "2026-11-08", "22:00", "arrive", "2026-11-09", "06:00"),
    ).not.toThrow();
  });
  it("rejects arrive before depart on the same day", () => {
    expect(() =>
      validateChronology("depart", "2026-11-08", "10:00", "arrive", "2026-11-08", "09:00"),
    ).toThrow(WanderlogValidationError);
  });
  it("rejects malformed date and time", () => {
    expect(() =>
      validateChronology("depart", "2026-13-01", "10:00", "arrive", "2026-11-08", "11:00"),
    ).toThrow(WanderlogValidationError);
    expect(() =>
      validateChronology("depart", "2026-11-08", "25:00", "arrive", "2026-11-08", "11:00"),
    ).toThrow(WanderlogValidationError);
  });
});
