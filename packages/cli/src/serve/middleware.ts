/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Request, type Response, type NextFunction } from 'express';
import type { ErrorResponse } from './openai-types.js';

/**
 * API key authentication middleware
 * Validates Bearer token in Authorization header
 */
export function authMiddleware(apiKey: string) {
  return (req: Request, res: Response<ErrorResponse>, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          message: 'Invalid or missing API key. Provide a Bearer token in the Authorization header.',
          type: 'authentication_error',
        },
      });
      return;
    }
    
    const providedKey = authHeader.slice(7);
    
    if (providedKey !== apiKey) {
      res.status(403).json({
        error: {
          message: 'Invalid API key',
          type: 'authentication_error',
        },
      });
      return;
    }
    
    next();
  };
}

/**
 * CORS middleware
 * Allows cross-origin requests from any origin
 */
export function corsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    
    next();
  };
}

/**
 * Request validation middleware for /v1/chat/completions
 * Ensures required fields are present and valid
 */
export function validateChatRequest(req: Request, res: Response<ErrorResponse>, next: NextFunction) {
  const body = req.body;
  
  // Check if body exists
  if (!body) {
    res.status(400).json({
      error: {
        message: 'Request body is required',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  
  // Check if messages field exists and is an array
  if (!body.messages || !Array.isArray(body.messages)) {
    res.status(400).json({
      error: {
        message: 'messages field is required and must be an array',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  
  // Check if messages array is not empty
  if (body.messages.length === 0) {
    res.status(400).json({
      error: {
        message: 'messages array must contain at least one message',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  
  // Validate each message has required fields
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    
    if (!msg.role) {
      res.status(400).json({
        error: {
          message: `Message at index ${i} is missing required 'role' field`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
    
    if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) {
      res.status(400).json({
        error: {
          message: `Invalid message role at index ${i}: '${msg.role}'. Must be one of: system, user, assistant, tool`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
    
    // Assistant messages with tool_calls don't need content
    if (msg.role === 'assistant' && !msg.tool_calls && !msg.content) {
      res.status(400).json({
        error: {
          message: `Assistant message at index ${i} must have either 'content' or 'tool_calls'`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
    
    // Non-assistant messages need content (can be empty string but not null/undefined)
    if (msg.role !== 'assistant' && msg.content === null && !msg.tool_calls) {
      res.status(400).json({
        error: {
          message: `Message at index ${i} with role '${msg.role}' must have 'content'`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
  }
  
  // Validate max_tokens if provided
  if (body.max_tokens !== undefined) {
    if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) {
      res.status(400).json({
        error: {
          message: 'max_tokens must be a positive number',
          type: 'invalid_request_error',
        },
      });
      return;
    }
  }
  
  // Validate temperature if provided
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2) {
      res.status(400).json({
        error: {
          message: 'temperature must be a number between 0 and 2',
          type: 'invalid_request_error',
        },
      });
      return;
    }
  }
  
  // Validate top_p if provided
  if (body.top_p !== undefined) {
    if (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1) {
      res.status(400).json({
        error: {
          message: 'top_p must be a number between 0 and 1',
          type: 'invalid_request_error',
        },
      });
      return;
    }
  }
  
  next();
}

/**
 * Error handler middleware
 * Catches and formats errors in OpenAI-compatible format
 */
export function errorHandler(err: Error, req: Request, res: Response<ErrorResponse>, next: NextFunction) {
  console.error('Unhandled error:', err);
  
  res.status(500).json({
    error: {
      message: err.message || 'Internal server error',
      type: 'api_error',
    },
  });
}
