import { createHmac } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { CaptureState, Room, SegmentInput, TranscriptSink } from "../src/domain.js";
import { occurrenceTitle, registerZoomWithDependencies, type ZoomAdapterDependencies } from "../src/adapters/zoom.js";
import type { RtmsSocket } from "../src/adapters/zoom-protocol.js";

class RecordingSink implements TranscriptSink {
  readonly ensured: Array<{ sourceId: string; externalId: string; title: string }> = [];
  readonly segments: Array<{ conversationId: string; segments: SegmentInput[] }> = [];
  readonly states: Array<{ conversationId: string; state: CaptureState; detail: string | null | undefined }> = [];
  readonly rooms: Room[] = [];
  readonly linked: Array<{ conversationId: string; roomId: string }> = [];

  ensureConversation(sourceId: string, externalId: string, title: string): { id: string } {
    this.ensured.push({ sourceId, externalId, title });
    return { id: `conversation-${externalId}` };
  }

  appendSegments(conversationId: string, segments: SegmentInput[]): void {
    this.segments.push({ conversationId, segments });
  }

  setCapture(conversationId: string, state: CaptureState, detail?: string | null): void {
    this.states.push({ conversationId, state, detail });
  }

  findRoom(sourceId: string, externalId: string): Room | null {
    return this.rooms.find((room) => room.sourceId === sourceId && room.externalId === externalId) ?? null;
  }

  createRoom(input: { name: string; sourceId: string; externalId: string; joinUrl: string; hostUser: string }): Room {
    const room: Room = { id: `room-${input.externalId}`, createdAt: 0, archivedAt: null, ...input };
    this.rooms.push(room);
    return room;
  }

  setConversationRoom(conversationId: string, roomId: string): void {
    this.linked.push({ conversationId, roomId });
  }
}

const SECRET = "webhook-secret";
const NOW_MS = 1_800_000_000_000;

function signedRequest(body: string, timestamp = String(NOW_MS / 1_000)): RequestInit {
  const digest = createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
  return {
    headers: {
      "content-type": "application/json",
      "x-zm-request-timestamp": timestamp,
      "x-zm-signature": `v0=${digest}`,
    },
    body,
  };
}

function dependencies(opened: string[] = []): ZoomAdapterDependencies {
  return {
    fetch: () => Promise.reject(new Error("no HTTP in protocol tests")),
    now: () => NOW_MS,
    socketFactory(url, _handlers): RtmsSocket {
      opened.push(url);
      return { send: () => undefined, close: () => undefined };
    },
  };
}

describe("occurrence titles", () => {
  it("distinguishes two occupancy periods of one recurring meeting", () => {
    // A recurring meeting keeps its id and gets a new meeting_uuid each time the room
    // fills. Leaving and rejoining produced two conversations titled identically.
    const first = occurrenceTitle("88126499248", Date.UTC(2026, 8, 11, 22, 1));
    const second = occurrenceTitle("88126499248", Date.UTC(2026, 8, 11, 22, 5));
    expect(first).toBe("Zoom meeting 88126499248 · 2026-09-11 22:01Z");
    expect(second).not.toBe(first);
  });

  it("falls back to a bare name when Zoom sends no meeting id or a nonsense anchor", () => {
    expect(occurrenceTitle("", Date.UTC(2026, 8, 11))).toBe("Zoom meeting · 2026-09-11 00:00Z");
    expect(occurrenceTitle("123", Number.NaN)).toBe("Zoom meeting 123");
  });
});

describe("Zoom source adapter webhook", () => {
  it("declares server-only secrets and reports configured and enabled separately", async () => {
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: false,
      },
    });
    const controller = registerZoomWithDependencies(host.bb, new RecordingSink(), dependencies());

    expect(host.harness.inspection.registrations.settingsDescriptors).toMatchObject({
      zoomClientId: { type: "string" },
      zoomClientSecret: { type: "string", secret: true },
      zoomWebhookSecret: { type: "string", secret: true },
      zoomEnabled: { type: "boolean", default: false },
      zoomApiClientSecret: { type: "string", secret: true },
    });
    // Capture credentials being present says nothing about room creation: the REST API needs a
    // separate Server-to-Server credential, so the two readiness flags move independently.
    await expect(controller.status()).resolves.toEqual({
      configured: true,
      enabled: false,
      canCreateRooms: false,
    });
  });

  it("validates a signed endpoint challenge from the raw request body", async () => {
    const host = createFakePluginHost({ settings: { zoomWebhookSecret: SECRET } });
    registerZoomWithDependencies(host.bb, new RecordingSink(), dependencies());
    const body = JSON.stringify({
      event: "endpoint.url_validation",
      event_ts: NOW_MS,
      payload: { plainToken: "challenge-token" },
    });

    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      plainToken: "challenge-token",
      encryptedToken: "7da852f23a0e8f48b0b651b06cc9ad0a11d4d1e5f0bd61014a08792cba8606e4",
    });
  });

  it("rejects invalid signatures, stale timestamps, and replayed deliveries", async () => {
    const host = createFakePluginHost({ settings: { zoomWebhookSecret: SECRET } });
    registerZoomWithDependencies(host.bb, new RecordingSink(), dependencies());
    const body = JSON.stringify({
      event: "endpoint.url_validation",
      event_ts: NOW_MS,
      payload: { plainToken: "challenge-token" },
    });

    const invalid = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", {
      ...signedRequest(body),
      headers: {
        "content-type": "application/json",
        "x-zm-request-timestamp": String(NOW_MS / 1_000),
        "x-zm-signature": "v0=invalid",
      },
    });
    const stale = await host.harness.behavior.fetchHttp(
      "POST",
      "/zoom/webhook",
      signedRequest(body, String(NOW_MS / 1_000 - 301)),
    );
    const accepted = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));
    const replay = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    expect(invalid.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(replay.status).toBe(409);
  });

  it("auto-starts only original-host events when enabled and fully configured", async () => {
    const opened: string[] = [];
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, dependencies(opened));
    const event = (originalHost: boolean, streamId: string) =>
      JSON.stringify({
        event: "meeting.rtms_started",
        event_ts: NOW_MS,
        payload: {
          meeting_uuid: "meeting-uuid",
          meeting_id: "123 456 789",
          operator_id: "operator-id",
          is_original_host: originalHost,
          rtms_stream_id: streamId,
          server_urls: "wss://rtms.zoom.us/signal",
        },
      });

    const nonHostBody = event(false, "stream-non-host");
    const hostBody = event(true, "stream-host");
    expect(
      (await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(nonHostBody))).status,
    ).toBe(204);
    expect(
      (await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(hostBody))).status,
    ).toBe(204);

    expect(sink.ensured).toEqual([
      { sourceId: "zoom", externalId: "meeting-uuid", title: "Zoom meeting 123 456 789 · 2027-01-15 08:00Z" },
    ]);
    expect(sink.states[0]).toMatchObject({
      conversationId: "conversation-meeting-uuid",
      state: "connecting",
    });
    expect(opened).toEqual(["wss://rtms.zoom.us/signal"]);
  });

  it("rejects signed start events whose RTMS destination could target the local network", async () => {
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, dependencies());
    const body = JSON.stringify({
      event: "meeting.rtms_started",
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-id",
        server_urls: "wss://127.0.0.1/internal",
      },
    });

    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    expect(response.status).toBe(400);
    expect(sink.ensured).toHaveLength(0);
  });

  it("does not let a late stopped event terminate a newer stream for the same occurrence", async () => {
    const sockets: Array<{ closed: boolean }> = [];
    const deps = dependencies();
    deps.socketFactory = () => {
      const record = { closed: false };
      sockets.push(record);
      return { send: () => undefined, close: () => void (record.closed = true) };
    };
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, deps);
    const event = (name: string, streamId: string) => JSON.stringify({
      event: name,
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: streamId,
        server_urls: "wss://rtms.zoom.us/signal",
        stop_reason: 6,
      },
    });
    for (const streamId of ["old-stream", "new-stream"]) {
      const body = event("meeting.rtms_started", streamId);
      await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));
    }
    const stateCount = sink.states.length;
    const lateStop = event("meeting.rtms_stopped", "old-stream");

    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(lateStop));

    expect(response.status).toBe(204);
    expect(sockets.at(-1)!.closed).toBe(false);
    expect(sink.states).toHaveLength(stateCount);
  });

  it("records the stop reason even when the socket ended the session first", async () => {
    // Production ordering: Zoom's signaling socket reports the stream stopped, which ends
    // the session and clears it from the active maps, and only then does the webhook
    // arrive. The webhook carries stop_reason, the only thing separating a deliberate end
    // from a dropped connection, so losing that race must not lose the reason.
    const signalingHandlers: Array<{ message(data: string): void }> = [];
    const deps: ZoomAdapterDependencies = {
      fetch: () => Promise.reject(new Error("no HTTP in protocol tests")),
      now: () => NOW_MS,
      socketFactory(_url, handlers): RtmsSocket {
        signalingHandlers.push(handlers as { message(data: string): void });
        return { send: () => undefined, close: () => undefined };
      },
    };
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, deps);
    const event = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      event: name,
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-1",
        server_urls: "wss://rtms.zoom.us/signal",
        ...extra,
      },
    });

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(event("meeting.rtms_started")));
    // msg_type 8 with state 3 is Zoom reporting the stream stopped; the session ends here.
    signalingHandlers[0]!.message(JSON.stringify({ msg_type: 8, state: 3 }));
    expect(sink.states.at(-1)!.state).toBe("ended");
    expect(sink.states.at(-1)!.detail).toBe("Zoom RTMS stream ended");

    const stopped = event("meeting.rtms_stopped", { stop_reason: 6 });
    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(stopped));

    expect(response.status).toBe(204);
    expect(sink.states.at(-1)!.detail).toBe("Zoom meeting ended");
  });

  it("reports a connection-failure stop reason as interrupted, not a clean end", async () => {
    // A host crash and a deliberate leave both close the socket identically. Only
    // stop_reason tells them apart, so this is the case the race was hiding.
    const signalingHandlers: Array<{ message(data: string): void }> = [];
    const deps: ZoomAdapterDependencies = {
      fetch: () => Promise.reject(new Error("no HTTP in protocol tests")),
      now: () => NOW_MS,
      socketFactory(_url, handlers): RtmsSocket {
        signalingHandlers.push(handlers as { message(data: string): void });
        return { send: () => undefined, close: () => undefined };
      },
    };
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, deps);
    const event = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      event: name,
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-1",
        server_urls: "wss://rtms.zoom.us/signal",
        ...extra,
      },
    });

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(event("meeting.rtms_started")));
    signalingHandlers[0]!.message(JSON.stringify({ msg_type: 8, state: 3 }));
    const stopped = event("meeting.rtms_stopped", { stop_reason: 12 });

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(stopped));

    expect(sink.states.at(-1)!.state).toBe("interrupted");
    expect(sink.states.at(-1)!.detail).toContain("connection failure (12)");
  });

  it("closes capture resources during BB disposal", async () => {
    let closeCount = 0;
    const deps = dependencies();
    deps.socketFactory = () => ({ send: () => undefined, close: () => void closeCount++ });
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    registerZoomWithDependencies(host.bb, new RecordingSink(), deps);
    const body = JSON.stringify({
      event: "meeting.rtms_started",
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-id",
        server_urls: "wss://rtms.zoom.us/signal",
      },
    });
    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    await host.harness.lifecycle.dispose();

    expect(closeCount).toBe(1);
  });
});

describe("rooms", () => {
  const startedBody = (meetingId: string, meetingUuid = "meeting-uuid") => JSON.stringify({
    event: "meeting.rtms_started",
    event_ts: NOW_MS,
    payload: {
      meeting_uuid: meetingUuid,
      meeting_id: meetingId,
      operator_id: "operator-id",
      is_original_host: true,
      rtms_stream_id: `stream-${meetingUuid}`,
      server_urls: "wss://rtms.zoom.us/signal",
    },
  });

  function captureHost() {
    return createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
  }

  it("links a capture to the room its meeting belongs to", async () => {
    const host = captureHost();
    const sink = new RecordingSink();
    sink.createRoom({
      name: "Team standup", sourceId: "zoom", externalId: "88800011122",
      joinUrl: "https://zoom.us/j/88800011122", hostUser: "operator@example.com",
    });
    registerZoomWithDependencies(host.bb, sink, dependencies());

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(startedBody("88800011122")));

    expect(sink.linked).toEqual([{ conversationId: "conversation-meeting-uuid", roomId: "room-88800011122" }]);
  });

  it("links every sitting of one room, though each is its own conversation", async () => {
    // meeting_uuid changes per occupancy period while the meeting id does not. This is what
    // gathers a room's sittings together after the fragmentation we measured.
    const host = captureHost();
    const sink = new RecordingSink();
    sink.createRoom({
      name: "Team standup", sourceId: "zoom", externalId: "88800011122",
      joinUrl: "https://zoom.us/j/88800011122", hostUser: "operator@example.com",
    });
    registerZoomWithDependencies(host.bb, sink, dependencies());

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(startedBody("88800011122", "uuid-one")));
    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(startedBody("88800011122", "uuid-two")));

    expect(sink.linked.map(({ roomId }) => roomId)).toEqual(["room-88800011122", "room-88800011122"]);
    expect(sink.ensured).toHaveLength(2);
  });

  it("captures a meeting that belongs to no room", async () => {
    // Most meetings were not created by BB. Having no room is normal, not a failure.
    const host = captureHost();
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, dependencies());

    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(startedBody("99900022233")));

    expect(response.status).toBe(204);
    expect(sink.linked).toEqual([]);
    expect(sink.ensured).toHaveLength(1);
  });

  it("refuses to create a room until the Server-to-Server credential is set", async () => {
    const host = captureHost();
    const controller = registerZoomWithDependencies(host.bb, new RecordingSink(), dependencies());

    // The RTMS credentials are present and capture works; creating a meeting is a different
    // credential entirely, and must fail loudly rather than silently doing nothing.
    await expect(controller.createRoom("Team standup")).rejects.toThrow(/Server-to-Server credential/);
  });

  it("records a room only after Zoom confirms the meeting", async () => {
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
        zoomAccountId: "account-1",
        zoomApiClientId: "api-client",
        zoomApiClientSecret: "api-secret",
        zoomHostUser: "operator@example.com",
      },
    });
    const sink = new RecordingSink();
    const deps: ZoomAdapterDependencies = {
      ...dependencies(),
      fetch: ((url: string) => Promise.resolve(
        String(url).startsWith("https://zoom.us/oauth/token")
          ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
          : new Response(JSON.stringify({ id: 88800011122, join_url: "https://zoom.us/j/888", topic: "Team standup" }), { status: 200 }),
      )) as unknown as typeof globalThis.fetch,
    };
    const controller = registerZoomWithDependencies(host.bb, sink, deps);

    const room = await controller.createRoom("Team standup");

    expect(room).toMatchObject({
      name: "Team standup",
      sourceId: "zoom",
      externalId: "88800011122",
      joinUrl: "https://zoom.us/j/888",
      hostUser: "operator@example.com",
    });
    expect(sink.rooms).toHaveLength(1);
  });

  it("stores no room when Zoom refuses the request", async () => {
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
        zoomAccountId: "account-1",
        zoomApiClientId: "api-client",
        zoomApiClientSecret: "api-secret",
        zoomHostUser: "operator@example.com",
      },
    });
    const sink = new RecordingSink();
    const deps: ZoomAdapterDependencies = {
      ...dependencies(),
      fetch: ((url: string) => Promise.resolve(
        String(url).startsWith("https://zoom.us/oauth/token")
          ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
          : new Response("{}", { status: 429 }),
      )) as unknown as typeof globalThis.fetch,
    };
    const controller = registerZoomWithDependencies(host.bb, sink, deps);

    await expect(controller.createRoom("Team standup")).rejects.toThrow(/429/);
    // A row with a join URL nobody can use would be worse than no row at all.
    expect(sink.rooms).toEqual([]);
  });
});
