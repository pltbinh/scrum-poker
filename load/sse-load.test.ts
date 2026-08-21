import { describe, expect, it, vi } from "vitest";
import { evaluateLoadResult, parseLoadOptions, runLoadCheck } from "./sse-load.ts";

describe("parseLoadOptions", () => {
  it("requires an explicit base URL and applies the Task 9 defaults", () => {
    expect(
      parseLoadOptions(["--base-url=http://127.0.0.1:4100"]),
    ).toEqual({
      allowedUnexpectedDisconnects: 0,
      baseUrl: "http://127.0.0.1:4100",
      durationSeconds: 300,
      expectedClients: 100,
      participantsPerRoom: 20,
      rooms: 5,
      rssCeilingMiB: 220,
    });
  });

  it("accepts the split base-url form", () => {
    expect(
      parseLoadOptions(["--base-url", "http://localhost:4100", "--duration-seconds=30"]),
    ).toMatchObject({
      baseUrl: "http://localhost:4100",
      durationSeconds: 30,
    });
  });

  it("parses the configured unexpected-disconnect allowance", () => {
    expect(
      parseLoadOptions([
        "--base-url=http://127.0.0.1:4100",
        "--allowed-unexpected-disconnects=2",
      ]),
    ).toMatchObject({
      allowedUnexpectedDisconnects: 2,
    });
  });

  it("allows an explicit zero unexpected-disconnect allowance", () => {
    expect(
      parseLoadOptions([
        "--base-url=http://127.0.0.1:4100",
        "--allowed-unexpected-disconnects=0",
      ]).allowedUnexpectedDisconnects,
    ).toBe(0);
  });

  it("ignores the pnpm double-dash separator", () => {
    expect(
      parseLoadOptions(["--", "--base-url=http://127.0.0.1:4100", "--duration-seconds=30"]),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:4100",
      durationSeconds: 30,
    });
  });

  it("rejects a missing base URL", () => {
    expect(() => parseLoadOptions([])).toThrow(/base-url/i);
  });

  it("rejects malformed base URLs", () => {
    expect(() => parseLoadOptions(["--base-url=not-a-url"])).toThrow(/valid http/i);
  });

  it("rejects production-looking base URLs", () => {
    expect(() => parseLoadOptions(["--base-url=https://poker-api.keothom24.com"])).toThrow(
      /production/i,
    );
  });

  it("rejects non-positive integers and the wrong client relationship", () => {
    expect(() => parseLoadOptions(["--base-url=http://127.0.0.1:4100", "--rooms=0"])).toThrow(
      /positive integer/i,
    );
    expect(
      () =>
        parseLoadOptions([
          "--base-url=http://127.0.0.1:4100",
          "--rooms=4",
          "--participants-per-room=20",
        ]),
    ).toThrow(/100 clients/i);
  });
});

describe("evaluateLoadResult", () => {
  it("passes when all Task 9 gates are satisfied", () => {
    expect(
      evaluateLoadResult({
        completedRooms: 5,
        connectedClients: 100,
        durationMs: 300_000,
        expectedClients: 100,
        initialSnapshots: 100,
        receivedBytes: 12_345,
        roomsAttempted: 5,
        rssMiB: 180,
        allowedUnexpectedDisconnects: 0,
        unexpectedDisconnects: 0,
      }),
    ).toEqual({
      metrics: {
        allowedUnexpectedDisconnects: 0,
        completedRooms: 5,
        connectedClients: 100,
        durationMs: 300_000,
        expectedClients: 100,
        initialSnapshots: 100,
        receivedBytes: 12_345,
        roomsAttempted: 5,
        rssMiB: 180,
        unexpectedDisconnects: 0,
      },
      ok: true,
      reasons: [],
    });
  });

  it("fails with actionable reasons for unmet gates", () => {
    expect(
      evaluateLoadResult({
        completedRooms: 4,
        connectedClients: 96,
        durationMs: 29_000,
        expectedClients: 100,
        initialSnapshots: 95,
        receivedBytes: 9_000,
        roomsAttempted: 5,
        rssMiB: 230,
        allowedUnexpectedDisconnects: 0,
        unexpectedDisconnects: 2,
      }),
    ).toEqual({
      metrics: {
        allowedUnexpectedDisconnects: 0,
        completedRooms: 4,
        connectedClients: 96,
        durationMs: 29_000,
        expectedClients: 100,
        initialSnapshots: 95,
        receivedBytes: 9_000,
        roomsAttempted: 5,
        rssMiB: 230,
        unexpectedDisconnects: 2,
      },
      ok: false,
      reasons: [
        "Expected 100 connected clients but observed 96.",
        "Expected 100 initial snapshots but observed 95.",
        "Expected 5 completed rooms but observed 4.",
        "Expected 0 or fewer unexpected disconnects but observed 2.",
        "Observed RSS 230 MiB exceeds the 220 MiB ceiling.",
      ],
    });
  });

  it("passes when unexpected disconnects are within the configured allowance", () => {
    expect(
      evaluateLoadResult({
        completedRooms: 5,
        connectedClients: 100,
        durationMs: 300_000,
        expectedClients: 100,
        initialSnapshots: 100,
        receivedBytes: 12_345,
        roomsAttempted: 5,
        rssMiB: 180,
        allowedUnexpectedDisconnects: 2,
        unexpectedDisconnects: 2,
      }),
    ).toMatchObject({
      ok: true,
      reasons: [],
    });
  });

  it("fails when unexpected disconnects exceed the configured allowance", () => {
    expect(
      evaluateLoadResult({
        completedRooms: 5,
        connectedClients: 100,
        durationMs: 300_000,
        expectedClients: 100,
        initialSnapshots: 100,
        receivedBytes: 12_345,
        roomsAttempted: 5,
        rssMiB: 180,
        allowedUnexpectedDisconnects: 2,
        unexpectedDisconnects: 3,
      }),
    ).toMatchObject({
      ok: false,
      reasons: ["Expected 2 or fewer unexpected disconnects but observed 3."],
    });
  });
});

describe("runLoadCheck", () => {
  it("aborts every partial SSE stream when initial snapshot setup times out", async () => {
    let streamCount = 0;
    let abortedStreamCount = 0;
    const encoder = new TextEncoder();

    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());

      if (init?.method === "POST" && url.pathname === "/api/rooms") {
        return Response.json({
          facilitatorToken: "facilitator-token",
          participantToken: "host-token",
          roomId: "room-1",
        });
      }

      if (init?.method === "POST" && url.pathname.endsWith("/join")) {
        return Response.json({ participantToken: `participant-${url.pathname}` });
      }

      if (init?.method === "POST" && url.pathname.endsWith("/stream-ticket")) {
        return Response.json({ expiresInSeconds: 30, ticket: `ticket-${streamCount}` });
      }

      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/stream")) {
        const signal = init.signal as AbortSignal;
        const streamIndex = streamCount;
        streamCount += 1;

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (streamIndex === 0) {
              controller.enqueue(
                encoder.encode(
                  `event: snapshot\ndata: ${JSON.stringify({
                    p: 0,
                    q: 0,
                    r: "room-1",
                    s: "self",
                    u: [],
                    v: 1,
                  })}\n\n`,
                ),
              );
            }

            signal.addEventListener(
              "abort",
              () => {
                abortedStreamCount += 1;
                controller.close();
              },
              { once: true },
            );
          },
        });

        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }

      throw new Error(`Unexpected fake request: ${init?.method ?? "GET"} ${url.pathname}`);
    };

    vi.useFakeTimers();
    try {
      const rejection = runLoadCheck(
        {
          allowedUnexpectedDisconnects: 0,
          baseUrl: "http://127.0.0.1:4100",
          durationSeconds: 1,
          expectedClients: 2,
          participantsPerRoom: 2,
          rooms: 1,
          rssCeilingMiB: 220,
        },
        { fetch: fetchImpl },
      ).then(
        () => {
          throw new Error("Expected the stalled initial snapshot setup to reject.");
        },
        (error: unknown) => error,
      );

      for (let attempt = 0; attempt < 1_000 && streamCount < 2; attempt += 1) {
        await Promise.resolve();
      }

      expect(streamCount).toBe(2);
      await vi.advanceTimersByTimeAsync(10_001);
      const error = await rejection;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Timed out waiting for the initial snapshot/);
      expect(abortedStreamCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }, 2_000);

});
