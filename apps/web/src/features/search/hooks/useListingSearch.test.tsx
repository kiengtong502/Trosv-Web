import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Listing, ListingQuery, Paged } from "@/shared/types/api";
import { useListingSearch } from "./useListingSearch";

const mocks = vi.hoisted(() => ({
  getListings: vi.fn(),
  setSearchParams: vi.fn(),
  params: new URLSearchParams(),
  cities: [{ id: 3, name: "TP.HCM" }],
  empty: [],
}));
vi.mock("react-router-dom", () => ({
  useSearchParams: () => [mocks.params, mocks.setSearchParams],
}));
vi.mock("@/features/listings/api/listingApi", () => ({ getListings: mocks.getListings }));
vi.mock("@/features/listings/hooks/useReferenceData", () => ({
  useCities: () => ({ data: mocks.cities }),
  useWards: () => ({ data: mocks.empty }),
  useSchools: () => ({ data: mocks.empty }),
  useAmenities: () => ({ data: mocks.empty }),
}));
vi.mock("@/shared/api/axiosClient", () => ({
  errMessage: (error: Error) => error.message,
}));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getListings.mockReset();
  mocks.setSearchParams.mockReset();
  mocks.params = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function deferred() {
  let resolve!: (value: Paged<Listing>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Paged<Listing>>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const response = (id: number, page = 1): Paged<Listing> => ({
  data: [{ id, title: `Room ${String(id)}` }] as Listing[],
  meta: { current_page: page, last_page: 3, total: 30, per_page: 12 },
});
const mapResponse = (id: number): Paged<Listing> => ({
  ...response(id),
  meta: { current_page: 1, last_page: 1, total: 1, per_page: 50 },
});
function mapPage(page: number, total = 120): Paged<Listing> {
  const start = (page - 1) * 50;
  return {
    data: Array.from({ length: Math.min(50, total - start) }, (_, index) => ({
      id: start + index + 1,
      title: `Map room ${String(start + index + 1)}`,
    })) as Listing[],
    meta: { current_page: page, last_page: Math.ceil(total / 50), total, per_page: 50 },
  };
}
function batch() {
  const paged = deferred();
  const map = deferred();
  mocks.getListings.mockReturnValueOnce(paged.promise).mockReturnValueOnce(map.promise);
  return { paged, map };
}
async function startRequest() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

for (const change of ["ward", "page"] as const) {
  it(`ignores an older success after the latest ${change} response for both list and map`, async () => {
    const old = batch();
    const latest = batch();
    const { result } = renderHook(() => useListingSearch());
    await startRequest();
    act(() => {
      if (change === "ward") result.current.setWard("42");
      else result.current.setPage(2);
    });
    await startRequest();
    await act(async () => {
      latest.map.resolve(mapResponse(200));
      latest.paged.resolve(response(20, 2));
      await Promise.all([latest.map.promise, latest.paged.promise]);
    });
    expect(result.current.listings[0]?.id).toBe(20);
    expect(result.current.mapListings[0]?.id).toBe(200);
    expect(result.current.meta?.current_page).toBe(2);
    await act(async () => {
      old.paged.resolve(response(10));
      old.map.resolve(mapResponse(100));
      await Promise.all([old.paged.promise, old.map.promise]);
    });
    expect(result.current.listings[0]?.id).toBe(20);
    expect(result.current.mapListings[0]?.id).toBe(200);
    expect(result.current.meta?.current_page).toBe(2);
    expect(result.current.error).toBe("");
    expect(result.current.loading).toBe(false);
  });
}

it("invalidates the old response during the next filter's debounce window", async () => {
  const old = batch();
  const latest = batch();
  const { result } = renderHook(() => useListingSearch());
  await startRequest();
  act(() => {
    result.current.setWard("42");
  });
  await act(async () => {
    old.paged.resolve(response(10));
    old.map.resolve(mapResponse(100));
    await Promise.all([old.paged.promise, old.map.promise]);
  });
  expect(mocks.getListings).toHaveBeenCalledTimes(2);
  expect(result.current.listings).toEqual([]);
  expect(result.current.mapListings).toEqual([]);
  expect(result.current.meta).toBeNull();
  expect(result.current.loading).toBe(true);
  await startRequest();
  await act(async () => {
    latest.paged.resolve(response(20));
    latest.map.resolve(mapResponse(200));
    await Promise.all([latest.paged.promise, latest.map.promise]);
  });
  expect(result.current.listings[0]?.id).toBe(20);
});

it("ignores stale failures without clearing newer results or finishing their loading state", async () => {
  const old = batch();
  const latest = batch();
  const { result } = renderHook(() => useListingSearch());
  await startRequest();
  act(() => {
    result.current.setWard("42");
  });
  await startRequest();
  await act(async () => {
    old.paged.reject(new Error("Old request failed"));
    old.map.resolve(mapResponse(100));
    await Promise.allSettled([old.paged.promise, old.map.promise]);
  });
  expect(result.current.error).toBe("");
  expect(result.current.loading).toBe(true);
  await act(async () => {
    latest.paged.resolve(response(20));
    latest.map.resolve(mapResponse(200));
    await Promise.all([latest.paged.promise, latest.map.promise]);
  });
  expect(result.current.listings[0]?.id).toBe(20);
  expect(result.current.mapListings[0]?.id).toBe(200);
  expect(result.current.error).toBe("");
});

it("clears the latest results and pagination when the latest request fails", async () => {
  const old = batch();
  const latest = batch();
  const { result } = renderHook(() => useListingSearch());
  await startRequest();
  await act(async () => {
    old.paged.resolve(response(10));
    old.map.resolve(mapResponse(100));
    await Promise.all([old.paged.promise, old.map.promise]);
  });
  act(() => {
    result.current.setWard("42");
  });
  await startRequest();
  await act(async () => {
    latest.paged.resolve(response(20));
    latest.map.reject(new Error("Latest map failed"));
    await Promise.allSettled([latest.paged.promise, latest.map.promise]);
  });
  expect(result.current.error).toBe("Latest map failed");
  expect(result.current.listings).toEqual([]);
  expect(result.current.mapListings).toEqual([]);
  expect(result.current.meta).toBeNull();
  expect(result.current.loading).toBe(false);
});

it("loads all map pages and keeps all 120 pins when the list page changes", async () => {
  mocks.getListings.mockImplementation((params: ListingQuery) =>
    Promise.resolve(
      params.per_page === 50 ? mapPage(Number(params.page)) : response(20, Number(params.page)),
    ),
  );
  const { result } = renderHook(() => useListingSearch());
  await startRequest();
  expect(result.current.mapListings).toHaveLength(120);
  expect(result.current.mapListings.at(-1)?.id).toBe(120);
  expect(mocks.getListings).toHaveBeenCalledWith(
    expect.objectContaining({ page: 3, per_page: 50 }),
  );
  act(() => {
    result.current.setPage(2);
  });
  await startRequest();
  expect(result.current.meta?.current_page).toBe(2);
  expect(result.current.mapListings).toHaveLength(120);
});

it("discards a stale later map page and stops loading its remaining pages", async () => {
  const late = deferred();
  mocks.params = new URLSearchParams("q=old");
  mocks.getListings.mockImplementation((params: ListingQuery) => {
    if (params.q === "old" && params.per_page === 50) {
      return params.page === 1 ? Promise.resolve(mapPage(1)) : late.promise;
    }
    return Promise.resolve(params.per_page === 50 ? mapResponse(900) : response(90));
  });
  const { result } = renderHook(() => useListingSearch());
  await startRequest();
  expect(mocks.getListings).toHaveBeenCalledWith(
    expect.objectContaining({ q: "old", page: 2, per_page: 50 }),
  );
  act(() => {
    result.current.setFilter("q", "latest");
  });
  await startRequest();
  await act(async () => {
    late.resolve(mapPage(2));
    await late.promise;
  });
  expect(result.current.listings[0]?.id).toBe(90);
  expect(result.current.mapListings.map((room) => room.id)).toEqual([900]);
  expect(mocks.getListings).not.toHaveBeenCalledWith(
    expect.objectContaining({ q: "old", page: 3, per_page: 50 }),
  );
});

it("reports a later map page failure instead of presenting the first 50 as complete", async () => {
  mocks.getListings.mockImplementation((params: ListingQuery) => {
    if (params.per_page === 50) {
      return params.page === 1
        ? Promise.resolve(mapPage(1))
        : Promise.reject(new Error("Map page 2 failed"));
    }
    return Promise.resolve(response(20));
  });
  const { result } = renderHook(() => useListingSearch());
  await startRequest();
  expect(result.current.error).toBe("Map page 2 failed");
  expect(result.current.mapListings).toEqual([]);
  expect(result.current.meta).toBeNull();
  expect(result.current.loading).toBe(false);
});
