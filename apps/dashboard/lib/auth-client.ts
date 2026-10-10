import { createAuthClient } from 'better-auth/react';

// Isomorphic (no 'use client'): server code (lib/session.ts) and client
// components share this instance. Auth is hosted by the backend
// (NEXT_PUBLIC_BETTER_AUTH_BACKEND_URL); this client only talks to it, holding no secrets.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_BACKEND_URL,
  fetchOptions: { credentials: 'include' },
});

export const { useSession, signIn, signUp, signOut, sendVerificationEmail } = authClient;
