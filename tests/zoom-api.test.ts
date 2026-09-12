import { describe, expect, it } from "vitest";
import { ZoomApi, type ZoomApiDependencies } from "../src/adapters/zoom-api.js";

const credentials = { accountId: "account-1", clientId: "api-client", clientSecret: "api-secret" };

interface Call { url: string; init: RequestInit | undefined }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that answers the token endpoint and returns queued API responses in order. */
function stub(responses: Response[], options: { now?: () => number; tokenExpiresIn?: number } = {}) {
  const calls: Call[] = [];
  let tokenExchanges = 0;
  const dependencies: ZoomApiDependencies = {
    now: options.now ?? (() => 1_000),
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://zoom.us/oauth/token")) {
        tokenExchanges++;
        return Promise.resolve(jsonResponse({
          access_token: `token-${tokenExchanges}`,
          expires_in: options.tokenExpiresIn ?? 3_600,
        }));
      }
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request to ${url}`);
      return Promise.resolve(next);
    }) as unknown as typeof globalThis.fetch,
  };
  return { calls, dependencies, exchanges: () => tokenExchanges };
}

const meeting = { id: 88800011122, join_url: "https://zoom.us/j/88800011122?pwd=tok", topic: "Team standup" };

describe("Zoom REST client", () => {
  it("creates a reusable room meeting that guests can start", async () => {
    const { calls, dependencies } = stub([jsonResponse(meeting)]);
    const api = new ZoomApi(credentials, dependencies);

    const created = await api.createRoomMeeting("operator@example.com", "Team standup");

    expect(created).toEqual({
      meetingId: "88800011122",
      joinUrl: "https://zoom.us/j/88800011122?pwd=tok",
      topic: "Team standup",
    });
    const request = calls.at(-1)!;
    expect(request.url).toBe("https://api.zoom.us/v2/users/operator%40example.com/meetings");
    const body = JSON.parse(String(request.init?.body));
    // Type 3 is recurring with no fixed time: one id and one join URL, reusable indefinitely.
    expect(body.type).toBe(3);
    // A waiting room overrides join before host, which would leave guests queueing for a host
    // who never arrives. Measured against a live meeting, so this assertion is load-bearing.
    expect(body.settings.waiting_room).toBe(false);
    expect(body.settings.join_before_host).toBe(true);
    // approval_type 2 disables registration, which would otherwise gate the join URL.
    expect(body.settings.approval_type).toBe(2);
  });

  it("returns the meeting id as a string when Zoom sends a number", async () => {
    const { dependencies } = stub([jsonResponse({ ...meeting, id: 123 })]);
    const created = await new ZoomApi(credentials, dependencies).createRoomMeeting("host", "Room");
    // Zoom sends meeting ids as JSON numbers large enough to lose precision in comparisons
    // elsewhere, and every other identifier in the hub is a string.
    expect(created.meetingId).toBe("123");
  });

  it("reuses a cached token across calls", async () => {
    const { dependencies, exchanges } = stub([jsonResponse(meeting), jsonResponse(meeting)]);
    const api = new ZoomApi(credentials, dependencies);

    await api.createRoomMeeting("host", "One");
    await api.createRoomMeeting("host", "Two");

    expect(exchanges()).toBe(1);
  });

  it("exchanges the credential again once the token expires", async () => {
    let now = 1_000;
    const { dependencies, exchanges } = stub([jsonResponse(meeting), jsonResponse(meeting)], {
      now: () => now,
      tokenExpiresIn: 120,
    });
    const api = new ZoomApi(credentials, dependencies);

    await api.createRoomMeeting("host", "One");
    now += 120_000;
    await api.createRoomMeeting("host", "Two");

    expect(exchanges()).toBe(2);
  });

  it("drops a rejected token so the next call does not replay it", async () => {
    const { dependencies, exchanges } = stub([jsonResponse({}, 401), jsonResponse(meeting)]);
    const api = new ZoomApi(credentials, dependencies);

    await expect(api.createRoomMeeting("host", "One")).rejects.toThrow(/rejected the access token/);
    await api.createRoomMeeting("host", "Two");

    expect(exchanges()).toBe(2);
  });

  it("reports a rejected credential without leaking it", async () => {
    const dependencies: ZoomApiDependencies = {
      now: () => 0,
      fetch: (() => Promise.resolve(jsonResponse({}, 400))) as unknown as typeof globalThis.fetch,
    };
    await expect(new ZoomApi(credentials, dependencies).createRoomMeeting("host", "Room"))
      .rejects.toThrow("Zoom rejected the Server-to-Server OAuth credential (400)");
  });

  it("sends the credential as basic auth on the token request only", async () => {
    const { calls, dependencies } = stub([jsonResponse(meeting)]);
    await new ZoomApi(credentials, dependencies).createRoomMeeting("host", "Room");

    const token = calls[0]!;
    expect(token.url).toContain("grant_type=account_credentials");
    expect(token.url).toContain("account_id=account-1");
    const headers = token.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("api-client:api-secret").toString("base64")}`);
    // The API call carries the bearer token, never the credential.
    const api = calls[1]!.init?.headers as Record<string, string>;
    expect(api.authorization).toBe("Bearer token-1");
  });

  it("reads a meeting topic and treats blank as absent", async () => {
    const { dependencies } = stub([jsonResponse({ ...meeting, topic: "Weekly planning" })]);
    await expect(new ZoomApi(credentials, dependencies).meetingTopic("123")).resolves.toBe("Weekly planning");

    const blank = stub([jsonResponse({ ...meeting, topic: "   " })]);
    await expect(new ZoomApi(credentials, blank.dependencies).meetingTopic("123")).resolves.toBeNull();
  });
});
