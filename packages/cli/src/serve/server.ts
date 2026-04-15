/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Request, type Response } from 'express';
import type { Config } from '@google/gemini-cli-core';
import { createSessionManager } from './session-manager.js';
import { handleChatCompletions } from './routes/chat.js';
import { authMiddleware, corsMiddleware, validateChatRequest, errorHandler } from './middleware.js';
import { getVersion } from '@google/gemini-cli-core';

/**
 * Server configuration options
 */
export interface ServerOptions {
  port: number;
  host: string;
  apiKey?: string;  // Optional API key to protect the /v1/chat/completions endpoint
}

/**
 * Start the OpenAI-compatible API server
 * This function never returns - it keeps the process alive until shutdown
 */
export async function runServer(config: Config, options: ServerOptions): Promise<void> {
  const app = express();
  const sessionManager = createSessionManager();
  
  // Get CLI version for health check
  const version = getVersion();
  
  // Apply global middleware
  app.use(corsMiddleware());
  app.use(express.json({ limit: '50mb' }));
  
  // Apply API key middleware if configured
  if (options.apiKey) {
    console.log('[Serve] API key authentication enabled');
    app.use('/v1/chat/completions', authMiddleware(options.apiKey));
  }
  
  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version,
      uptime: process.uptime(),
      sessions: sessionManager.activeSessionCount,
    });
  });
  
  // OpenAI-compatible models endpoint
  app.get('/v1/models', (req: Request, res: Response) => {
    res.json({
      object: 'list',
      data: [{
        id: 'gemini',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google',
      }],
    });
  });
  
  // OpenAI-compatible chat completions endpoint
  app.post('/v1/chat/completions', validateChatRequest, (req: Request, res: Response) => {
    handleChatCompletions(req, res, config, sessionManager);
  });
  
  // Error handler (must be last)
  app.use(errorHandler);
  
  // Start the server
  const server = app.listen(options.port, options.host, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         Gemini CLI - OpenAI-Compatible Server             ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Server running on: http://${options.host}:${options.port}              ║`);
    console.log(`║  Endpoint:           http://${options.host}:${options.port}/v1/chat/completions  ║`);
    console.log(`║  Health check:       http://${options.host}:${options.port}/health              ║`);
    console.log(`║  Model:              gemini                                   ║`);
    if (options.apiKey) {
      console.log(`║  Auth:               Bearer token required                    ║`);
    } else {
      console.log(`║  Auth:               None (local development)                 ║`);
    }
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('[Serve] Press Ctrl+C to stop the server');
    console.log('');
  });
  
  // Graceful shutdown handlers
  const shutdown = (signal: string) => {
    console.log(`\n[Serve] Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      console.log('[Serve] Server closed');
      process.exit(0);
    });
    
    // Force exit after 10 seconds
    setTimeout(() => {
      console.error('[Serve] Force exiting after timeout');
      process.exit(1);
    }, 10000);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  // Keep the process alive - this promise never resolves
  return new Promise<void>((resolve, reject) => {
    server.on('error', (err) => {
      console.error('[Serve] Server error:', err);
      reject(err);
    });
  });
}
