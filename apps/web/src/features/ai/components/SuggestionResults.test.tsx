import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiAreaSuggestion } from "@/shared/types/api";
import { filtersFromParams, filtersToApiParams } from "@/features/search/lib/searchFilters";
import { useAreaSuggestions } from "../hooks/useAreaSuggestions";
import { SuggestionResults } from "./SuggestionResults";

const mocks = vi.hoisted(() => ({ suggest: vi.fn() }));
vi.mock("../api/aiApi", () => ({ aiAreaSuggestions: mocks.suggest }));
vi.mock("@/features/auth/context/AuthContext", () => ({ useAuth: () => ({ user: null }) }));

const areas: AiAreaSuggestion[] = [{ ward_id: 42, name: "Tân Hưng" }];
beforeEach(() => mocks.suggest.mockReset());
afterEach(cleanup);

it.each(["61", ""])(
  "keeps the suggested ward and submitted school (%s) in room search",
  async (school) => {
    mocks.suggest.mockResolvedValue(areas);
    const { result } = renderHook(() => useAreaSuggestions());
    act(() => {
      result.current.setSchoolId(school);
    });
    await act(() => result.current.suggest());
    render(
      <MemoryRouter>
        <SuggestionResults s={result.current} />
      </MemoryRouter>,
    );

    const href = screen.getByRole("link", { name: "Xem phòng khu vực này" }).getAttribute("href");
    if (!href) throw new Error("Missing room search link");
    const params = new URL(href, "http://localhost").searchParams;
    expect(params.get("ward_id")).toBe("42");
    expect(params.get("school_id")).toBe(school || null);
    expect(filtersToApiParams(filtersFromParams(params), 1)).toMatchObject({
      ward_id: "42",
      ...(school ? { school_id: school } : {}),
    });
  },
);

it("keeps results linked to their submitted school when the form changes during a request", async () => {
  let resolve!: (rows: AiAreaSuggestion[]) => void;
  mocks.suggest.mockReturnValue(
    new Promise<AiAreaSuggestion[]>((done) => {
      resolve = done;
    }),
  );
  const { result } = renderHook(() => useAreaSuggestions());
  act(() => {
    result.current.setSchoolId("61");
  });
  let request!: Promise<void>;
  act(() => {
    request = result.current.suggest();
  });
  act(() => {
    result.current.setSchoolId("62");
  });
  await act(async () => {
    resolve(areas);
    await request;
  });
  render(
    <MemoryRouter>
      <SuggestionResults s={result.current} />
    </MemoryRouter>,
  );
  expect(screen.getByRole("link").getAttribute("href")).toContain("school_id=61");
});
