import type { StaffRole } from './permissions.js';

/**
 * The resolved staff principal attached to a request by staff-auth middleware
 * (ADR-0004 §2.5). Handlers and services read role/userId from here; it is
 * populated only after a valid session token resolves.
 */
export interface StaffPrincipal {
  userId: string;
  sessionId: string;
  role: StaffRole;
  displayName: string;
  email: string;
}

export interface StaffUser {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
}

export interface CreateStaffUserInput {
  email: string;
  displayName: string;
  role: StaffRole;
  password: string;
}

export interface UpdateStaffUserInput {
  role?: StaffRole;
  status?: 'active' | 'disabled';
  displayName?: string;
}

/** Result of a successful login — the plaintext token is returned once. */
export interface SessionIssueResult {
  token: string;
  sessionId: string;
  expiresAt: string;
}

/** A resolved, usable session (the plaintext token is NOT included). */
export interface ResolvedSession {
  userId: string;
  sessionId: string;
  role: StaffRole;
  displayName: string;
  email: string;
  expiresAt: string;
}

/**
 * Staff + session management service (ADR-0004 §2.1/§2.5). Owns user records,
 * password hashing, session issue/resolve/revoke, and user/role mutations.
 * Session tokens are returned as plaintext exactly once at issue; only their
 * hash is stored.
 */
export interface StaffService {
  /** Authenticate by email + password, issuing a new session. Returns null on bad credentials / disabled user. */
  login(
    email: string,
    password: string,
    issuedContext?: {
      ipHash?: string | undefined;
      userAgentHash?: string | undefined;
    },
  ): Promise<SessionIssueResult | null>;

  /** Resolve a presented token to a usable session, or null if missing/expired/revoked/disabled. */
  resolveSession(token: string): Promise<ResolvedSession | null>;

  /** Marks last_usedAt on a valid session (sliding activity). No-op if the session is no longer usable. */
  touchSession(sessionId: string): Promise<void>;

  /** Revokes a single session by id (logout). */
  revokeSession(sessionId: string): Promise<void>;

  /** Revokes every active session for a user (role-down / disable / password change). */
  revokeAllSessions(userId: string): Promise<void>;

  /** Refreshes a session's lifetime, returning a new plaintext token. */
  refreshSession(sessionId: string): Promise<SessionIssueResult | null>;

  listStaff(): Promise<StaffUser[]>;
  createStaffUser(input: CreateStaffUserInput): Promise<StaffUser>;
  updateStaffUser(userId: string, input: UpdateStaffUserInput): Promise<StaffUser>;
  getStaffUserByEmail(email: string): Promise<StaffUser | null>;
}
