/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/gemini-cli-core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Represents a conversation session with its client and history
 */
export interface Session {
  id: string;
  history: Content[];
  createdAt: Date;
  lastAccessed: Date;
  messageCount: number;
}

/**
 * Session manager interface for creating, retrieving, and managing sessions
 */
export interface SessionManager {
  getOrCreateSession(sessionId?: string): Session;
  getSession(sessionId: string): Session | undefined;
  deleteSession(sessionId: string): void;
  cleanupExpiredSessions(): void;
  readonly activeSessionCount: number;
}

/**
 * Create a session manager instance
 * Manages multiple conversation sessions and their state
 */
export function createSessionManager(): SessionManager {
  const sessions = new Map<string, Session>();
  
  return {
    /**
     * Get an existing session or create a new one
     */
    getOrCreateSession(sessionId?: string): Session {
      const id = sessionId || uuidv4();
      
      if (sessions.has(id)) {
        const session = sessions.get(id)!;
        session.lastAccessed = new Date();
        return session;
      }
      
      // Create new session
      const session: Session = {
        id,
        history: [],
        createdAt: new Date(),
        lastAccessed: new Date(),
        messageCount: 0,
      };
      
      sessions.set(id, session);
      return session;
    },
    
    /**
     * Get a session by ID (returns undefined if not found)
     */
    getSession(sessionId: string): Session | undefined {
      return sessions.get(sessionId);
    },
    
    /**
     * Delete a session by ID
     */
    deleteSession(sessionId: string): void {
      sessions.delete(sessionId);
    },
    
    /**
     * Clean up sessions that haven't been accessed within the TTL
     */
    cleanupExpiredSessions(ttlMs: number = 24 * 60 * 60 * 1000): void {
      const now = Date.now();
      
      for (const [id, session] of sessions) {
        if (now - session.lastAccessed.getTime() > ttlMs) {
          sessions.delete(id);
        }
      }
    },
    
    /**
     * Get the number of active sessions (for debugging/monitoring)
     */
    get activeSessionCount(): number {
      return sessions.size;
    },
  };
}
