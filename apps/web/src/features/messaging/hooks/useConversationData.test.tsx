import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/api";
import { useConversationData } from "./useConversationData";

const mocks = vi.hoisted(() => ({
  getConversations: vi.fn(),
  getMessages: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock("@/features/messaging/api/messagingApi", () => mocks);
beforeEach(() => {
  mocks.getConversations.mockReset().mockResolvedValue([{ id: 9 }, { id: 10 }]);
  mocks.getMessages.mockReset().mockResolvedValue([]);
  mocks.markRead.mockReset().mockResolvedValue(undefined);
});

const message = (id: number): Message => ({
  id,
  conversation_id: 9,
  sender_id: 2,
  body: `Message ${String(id)}`,
  created_at: "2026-11-15T00:00:00Z",
});
function deferred() {
  let resolve!: (messages: Message[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Message[]>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("retries a stale initial load without losing realtime messages or HTTP gaps", async () => {
  const initial = deferred();
  const catchup = deferred();
  mocks.getMessages.mockReturnValueOnce(initial.promise).mockReturnValueOnce(catchup.promise);
  const { result } = renderHook(() => useConversationData(9));
  act(() => {
    result.current.setMessages([message(503)]);
    result.current.lastIdRef.current = 503;
    result.current.syncMessages();
  });
  await act(async () => {
    initial.resolve([message(1), message(500)]);
    await initial.promise;
  });
  await waitFor(() => {
    expect(mocks.getMessages).toHaveBeenCalledTimes(2);
  });
  expect(mocks.getMessages).toHaveBeenLastCalledWith(9, null);
  expect(result.current.messages.map((row) => row.id)).toEqual([503]);
  expect(result.current.lastIdRef.current).toBe(503);
  expect(result.current.loaded).toBe(false);
  expect(mocks.markRead).not.toHaveBeenCalled();
  await act(async () => {
    catchup.resolve([message(1), message(500), message(501), message(502), message(503)]);
    await catchup.promise;
  });
  await waitFor(() => {
    expect(result.current.loaded).toBe(true);
  });
  expect(result.current.messages.map((row) => row.id)).toEqual([1, 500, 501, 502, 503]);
  expect(mocks.markRead).toHaveBeenCalledOnce();
});

it("loads new messages incrementally and coalesces overlapping sync requests", async () => {
  mocks.getMessages.mockResolvedValueOnce([message(1)]);
  const { result } = renderHook(() => useConversationData(9));
  await waitFor(() => {
    expect(result.current.loaded).toBe(true);
  });
  const catchup = deferred();
  mocks.getMessages.mockReturnValueOnce(catchup.promise).mockResolvedValueOnce([]);
  act(() => {
    result.current.syncMessages();
    result.current.syncMessages();
  });
  expect(mocks.getMessages).toHaveBeenCalledTimes(2);
  await act(async () => {
    catchup.resolve([message(2), message(3)]);
    await catchup.promise;
  });
  await waitFor(() => {
    expect(mocks.getMessages).toHaveBeenCalledTimes(3);
  });
  expect(mocks.getMessages).toHaveBeenLastCalledWith(9, 3);
  expect(result.current.messages.map((row) => row.id)).toEqual([1, 2, 3]);
});

it("refreshes old unsent messages, reactions, receipts and hidden rows after reconnect", async () => {
  mocks.getMessages.mockResolvedValueOnce([message(1), message(2), message(3), message(4)]);
  const { result } = renderHook(() => useConversationData(9));
  await waitFor(() => {
    expect(result.current.loaded).toBe(true);
  });
  const rows = [
    { ...message(1), is_unsent: true, body: null, attachment_url: null },
    { ...message(2), reactions: { "2": "❤️" } },
    { ...message(3), seen_at: "2026-11-15T01:00:00Z" },
    message(5),
  ];
  mocks.getMessages.mockResolvedValueOnce(rows);
  act(() => {
    result.current.syncMessages(true);
  });
  await waitFor(() => {
    expect(result.current.messages).toEqual(rows);
  });
  expect(mocks.getMessages).toHaveBeenLastCalledWith(9, null);
  expect(mocks.markRead).toHaveBeenCalledTimes(2);
});

it("does not overwrite live edits or restore hidden messages with an older refresh", async () => {
  mocks.getMessages.mockResolvedValueOnce([message(1), message(2), message(3)]);
  const { result } = renderHook(() => useConversationData(9));
  await waitFor(() => {
    expect(result.current.loaded).toBe(true);
  });
  const stale = deferred();
  const fresh = deferred();
  mocks.getMessages.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
  act(() => {
    result.current.syncMessages(true);
  });
  const changed = [
    { ...message(1), is_unsent: true, body: null },
    { ...message(2), reactions: { "1": "❤️" } },
  ];
  act(() => {
    result.current.setMessages(changed);
  });
  await act(async () => {
    stale.resolve([message(1), message(2), message(3)]);
    await stale.promise;
  });
  await waitFor(() => {
    expect(mocks.getMessages).toHaveBeenCalledTimes(3);
  });
  expect(result.current.messages).toEqual(changed);
  expect(mocks.markRead).toHaveBeenCalledOnce();
  expect(mocks.getMessages).toHaveBeenLastCalledWith(9, null);
  await act(async () => {
    fresh.resolve([...changed, message(4)]);
    await fresh.promise;
  });
  await waitFor(() => {
    expect(result.current.messages).toEqual([...changed, message(4)]);
  });
});

it("keeps a reconnect refresh queued behind an incremental request", async () => {
  mocks.getMessages.mockResolvedValueOnce([message(1)]);
  const { result } = renderHook(() => useConversationData(9));
  await waitFor(() => {
    expect(result.current.loaded).toBe(true);
  });
  const incremental = deferred();
  const updated = { ...message(1), seen_at: "2026-11-15T01:00:00Z" };
  mocks.getMessages.mockReturnValueOnce(incremental.promise).mockResolvedValueOnce([updated]);
  act(() => {
    result.current.syncMessages();
    result.current.syncMessages(true);
    result.current.syncMessages();
  });
  expect(mocks.getMessages).toHaveBeenLastCalledWith(9, 1);
  await act(async () => {
    incremental.resolve([]);
    await incremental.promise;
  });
  await waitFor(() => {
    expect(result.current.messages).toEqual([updated]);
  });
  expect(mocks.getMessages).toHaveBeenLastCalledWith(9, null);
});

it("retries a failed reconnect refresh as a full history instead of skipping old changes", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    mocks.getMessages.mockResolvedValueOnce([message(1)]);
    const { result } = renderHook(() => useConversationData(9));
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    mocks.getMessages.mockRejectedValueOnce(new Error("offline"));
    act(() => {
      result.current.syncMessages(true);
    });
    await waitFor(() => {
      expect(warning).toHaveBeenCalledOnce();
    });
    const updated = { ...message(1), is_unsent: true, body: null };
    mocks.getMessages.mockResolvedValueOnce([updated]);
    act(() => {
      result.current.syncMessages();
    });
    await waitFor(() => {
      expect(result.current.messages).toEqual([updated]);
    });
    expect(mocks.getMessages).toHaveBeenLastCalledWith(9, null);
  } finally {
    warning.mockRestore();
  }
});

it("does not mark an incomplete history read and retries from the last confirmed cursor", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    mocks.getMessages.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useConversationData(9));
    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(mocks.markRead).not.toHaveBeenCalled();
    mocks.getMessages.mockResolvedValueOnce([message(1)]);
    act(() => {
      result.current.syncMessages();
    });
    await waitFor(() => {
      expect(mocks.markRead).toHaveBeenCalledOnce();
    });
    expect(mocks.getMessages).toHaveBeenLastCalledWith(9, null);
  } finally {
    warning.mockRestore();
  }
});

it("ignores responses from a thread that was left", async () => {
  const previous = deferred();
  mocks.getMessages.mockReturnValueOnce(previous.promise).mockResolvedValueOnce([message(10)]);
  const { result, rerender } = renderHook(({ id }) => useConversationData(id), {
    initialProps: { id: 9 },
  });
  rerender({ id: 10 });
  await waitFor(() => {
    expect(result.current.loaded).toBe(true);
  });
  await act(async () => {
    previous.resolve([message(99)]);
    await previous.promise;
  });
  expect(result.current.messages.map((row) => row.id)).toEqual([10]);
  expect(mocks.markRead).not.toHaveBeenCalledWith(9);
});
