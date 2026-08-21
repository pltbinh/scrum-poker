import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeSnapshot, encodeSnapshot, type RoomSnapshot } from "../src/index.js";

describe("compact room snapshots", () => {
  it("stays byte-compatible with the shared backend wire-v1 fixture", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/scrum-poker-wire-v1.json", import.meta.url), "utf8"),
    );

    expect(encodeSnapshot(decodeSnapshot(fixture.voting))).toEqual(fixture.voting);
    expect(encodeSnapshot(decodeSnapshot(fixture.revealed))).toEqual(fixture.revealed);

    const leakedVotingSnapshot = structuredClone(fixture.voting);
    leakedVotingSnapshot.u[0].push("5");
    expect(() => decodeSnapshot(leakedVotingSnapshot)).toThrow(/hidden vote/i);
  });

  it("round-trips a revealed room", () => {
    const snapshot: RoomSnapshot = {
      roomId: "room-1",
      revision: 4,
      phase: "revealed",
      selfParticipantId: "p1",
      participants: [
        { id: "p1", displayName: "Alex", hasVoted: true, vote: "5" },
        { id: "p2", displayName: "Sam", hasVoted: false },
      ],
    };
    expect(decodeSnapshot(encodeSnapshot(snapshot))).toEqual(snapshot);
  });

  it("rejects hidden vote values during voting", () => {
    expect(() => decodeSnapshot({
      v: 1, r: "room-1", q: 2, s: "p1", p: 0,
      u: [["p1", "Alex", 1, "5"]],
    })).toThrow(/hidden vote/i);
  });

  it("rejects unsupported snapshot versions", () => {
    expect(() => decodeSnapshot({
      v: 2,
      r: "room-1",
      q: 1,
      s: "p1",
      p: 1,
      u: [],
    })).toThrow(/unsupported version/i);
  });

  it("rejects malformed participant tuples", () => {
    expect(() => decodeSnapshot({
      v: 1,
      r: "room-1",
      q: 1,
      s: "p1",
      p: 1,
      u: [["p1", "Alex"]],
    })).toThrow(/malformed/i);
  });

  it("rejects invalid revealed vote values", () => {
    expect(() => decodeSnapshot({
      v: 1,
      r: "room-1",
      q: 1,
      s: "p1",
      p: 1,
      u: [["p1", "Alex", 1, "99"]],
    })).toThrow(/invalid deck value/i);
  });
});
