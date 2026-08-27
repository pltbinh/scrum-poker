import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomApi } from "../src/api/room-api.js";
import type { RoomCredentialStore } from "../src/auth/room-credentials.js";
import { App } from "../src/app.js";

function createApi(): RoomApi {
  return {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    createStreamTicket: vi.fn(),
    vote: vi.fn(),
    reveal: vi.fn(),
    reset: vi.fn(),
  };
}

function createCredentials(savedDisplayName: string | null = null): RoomCredentialStore {
  return {
    load: vi.fn(() => null),
    loadDisplayName: vi.fn(() => savedDisplayName),
    save: vi.fn(),
    saveDisplayName: vi.fn(),
    remove: vi.fn(),
  };
}

describe("App routing", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("renders the shell and restores the room code from a shared hash route", async () => {
    window.location.hash = "#/room/room-restore";

    render(<App api={createApi()} credentials={createCredentials("Sam")} />);

    expect(screen.getByRole("link", { name: /skip to main content/i })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("button", { name: /toggle theme/i })).toBeInTheDocument();
    expect(await screen.findByLabelText(/room code/i)).toHaveValue("room-restore");
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Sam");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("redirects unknown hashes back to the landing page", async () => {
    window.location.hash = "#/not-a-route";

    render(<App api={createApi()} credentials={createCredentials()} />);

    expect(
      await screen.findByRole("heading", { name: /ready to play/i }, { timeout: 5000 }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(window.location.hash).toBe("#/");
    });
  });

  it("updates the join form when the shared room hash changes while mounted", async () => {
    window.location.hash = "#/room/room-a";

    const api = createApi();
    const credentials = createCredentials();
    const { rerender } = render(<App api={api} credentials={credentials} />);

    expect(await screen.findByLabelText(/room code/i)).toHaveValue("room-a");

    await act(async () => {
      window.location.hash = "#/room/room-b";
      rerender(<App api={api} credentials={credentials} />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/room code/i)).toHaveValue("room-b");
    });
  });
});
