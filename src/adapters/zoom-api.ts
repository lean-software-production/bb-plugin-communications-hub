import { z } from 'zod';

/**
 * Zoom REST calls for creating and naming meetings.
 *
 * Separate from the RTMS adapter on purpose. RTMS is push: Zoom signs a webhook and we
 * open a socket, using the General app's client id and secret only to sign the handshake.
 * This module is pull, and needs a Server-to-Server OAuth credential that can act on the
 * account. The two sets of credentials are not interchangeable, and neither is reachable
 * from an agent tool.
 */

const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_BASE = 'https://api.zoom.us/v2';
/** Refresh early so a call never travels with a token that expires in flight. */
const EXPIRY_MARGIN_MS = 60_000;

export interface ZoomApiCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

export interface ZoomApiDependencies {
  fetch: typeof globalThis.fetch;
  now(): number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
}).passthrough();

const meetingResponseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  join_url: z.string().min(1).max(2_048),
  topic: z.string().optional(),
  host_id: z.string().optional(),
  password: z.string().optional(),
}).passthrough();

export interface CreatedMeeting {
  meetingId: string;
  joinUrl: string;
  topic: string;
}

/** A recurring meeting with no fixed time: one meeting id and one join URL, reusable forever. */
const RECURRING_NO_FIXED_TIME = 3;

/**
 * Meeting settings a room depends on.
 *
 * `waiting_room` must be false. A waiting room overrides join before host, so guests would
 * queue for a host who never arrives — measured, not assumed. `approval_type: 2` disables
 * registration, which would otherwise gate the join URL behind a form.
 *
 * Nothing here enables transcript capture. RTMS auto-start is a per-user Zoom Apps setting
 * belonging to the host, not a meeting field, so the host must be the account that installed
 * the RTMS app.
 */
const ROOM_SETTINGS = {
  join_before_host: true,
  jbh_time: 0,
  waiting_room: false,
  approval_type: 2,
  mute_upon_entry: false,
  auto_recording: 'none',
} as const;

export class ZoomApi {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private credentials: ZoomApiCredentials,
    private dependencies: ZoomApiDependencies,
  ) {}

  /**
   * Fetch and cache an account-credentials token.
   *
   * Server-to-Server OAuth has no user to redirect and no refresh token: the credential is
   * exchanged for a short-lived token on demand. Caching it keeps a burst of calls to one
   * exchange; Zoom rate-limits the token endpoint separately from the API.
   */
  private async accessToken(): Promise<string> {
    const current = this.token;
    if (current && current.expiresAt > this.dependencies.now()) return current.value;
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64');
    const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(this.credentials.accountId)}`;
    const response = await this.dependencies.fetch(url, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    if (!response.ok) throw new Error(`Zoom rejected the Server-to-Server OAuth credential (${response.status})`);
    const parsed = tokenResponseSchema.parse(await response.json());
    const expiresAt = this.dependencies.now() + parsed.expires_in * 1_000 - EXPIRY_MARGIN_MS;
    this.token = { value: parsed.access_token, expiresAt };
    return parsed.access_token;
  }

  private async call(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const token = await this.accessToken();
    const response = await this.dependencies.fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status === 401) {
      // The cached token was rejected. Drop it so the next attempt exchanges the credential
      // again rather than replaying a token Zoom has already refused.
      this.token = null;
      throw new Error('Zoom rejected the access token. Check the Server-to-Server OAuth credential.');
    }
    if (!response.ok) throw new Error(`Zoom API request failed (${response.status})`);
    return response.json();
  }

  /**
   * Create a reusable room meeting hosted by `hostUser`.
   *
   * `hostUser` is an email address or Zoom user id and must be the account that installed the
   * RTMS app. Server-to-Server OAuth acts on the account rather than a signed-in user, so
   * there is no implicit "me" to fall back on.
   */
  async createRoomMeeting(hostUser: string, topic: string): Promise<CreatedMeeting> {
    const body = { topic, type: RECURRING_NO_FIXED_TIME, settings: ROOM_SETTINGS };
    const parsed = meetingResponseSchema.parse(
      await this.call(`/users/${encodeURIComponent(hostUser)}/meetings`, { method: 'POST', body }),
    );
    return { meetingId: String(parsed.id), joinUrl: parsed.join_url, topic: parsed.topic ?? topic };
  }

  /** Read a meeting's topic. RTMS events carry no topic, so naming a capture needs this call. */
  async meetingTopic(meetingId: string): Promise<string | null> {
    const parsed = meetingResponseSchema.parse(
      await this.call(`/meetings/${encodeURIComponent(meetingId)}`, { method: 'GET' }),
    );
    const topic = parsed.topic?.trim();
    return topic ? topic : null;
  }
}
