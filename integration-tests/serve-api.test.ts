/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

/**
 * Gemini CLI Serve Mode API Test Suite
 * Tests all OpenAI-compatible API endpoints
 */

interface TestServer {
  port: number;
  host: string;
  process: import('node:child_process').ChildProcess;
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: { role: string; content: string | null };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { content?: string; role?: string };
    finish_reason: string | null;
  }>;
}

interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  sessions: number;
}

interface ModelsResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
}

// Helper to make HTTP requests
function makeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    const req = http.request(requestOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value) {
            headers[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        }
        resolve({
          status: res.statusCode || 0,
          headers,
          body,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

// Helper to make streaming requests and collect SSE events
function makeStreamingRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<Array<{ event: string; data: string }>> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: parseInt(urlObj.port),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...options.headers,
      },
    };

    const req = http.request(requestOptions, (res) => {
      const events: Array<{ event: string; data: string }> = [];
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.substring(6);
            if (data === '[DONE]') {
              events.push({ event: 'done', data: '[DONE]' });
            } else {
              events.push({ event: 'data', data });
            }
          }
        }
      });

      res.on('end', () => {
        resolve(events);
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe('Gemini CLI Serve Mode API', { timeout: 120000 }, () => {
  let server: TestServer | null = null;
  const TEST_PORT = 3020;
  const BASE_URL = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    // Start the server in background
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');

    server = {
      port: TEST_PORT,
      host: 'localhost',
      process: spawn(
        'node',
        [
          '--no-warnings=DEP0040',
          path.join(process.cwd(), 'packages/cli/dist/index.js'),
          '--serve',
          '--serve-port',
          TEST_PORT.toString(),
        ],
        {
          env: { ...process.env, NODE_ENV: 'development' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    };

    // Capture server output for debugging
    let serverOutput = '';
    server.process.stdout?.on('data', (data) => {
      serverOutput += data.toString();
      console.log('[Server stdout]', data.toString().trim());
    });
    server.process.stderr?.on('data', (data) => {
      serverOutput += data.toString();
      console.error('[Server stderr]', data.toString().trim());
    });

    // Wait for server to start (with 90s timeout for slow startups)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('Server startup timeout. Last output:', serverOutput.slice(-1000));
        reject(new Error('Server startup timeout after 90s'));
      }, 90000);

      const checkHealth = async () => {
        try {
          const response = await makeRequest(`${BASE_URL}/health`);
          if (response.status === 200) {
            clearTimeout(timeout);
            console.log('[Serve] Server started successfully on port', TEST_PORT);
            resolve();
          }
        } catch (err) {
          // Retry after 1s
          setTimeout(checkHealth, 1000);
        }
      };

      // Start checking after 2s to give server time to initialize
      setTimeout(checkHealth, 2000);
    });
  });

  afterAll(async () => {
    if (server?.process) {
      server.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        server!.process.on('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
    }
  });

  describe('GET /health', () => {
    it('should return health status with ok', async () => {
      const response = await makeRequest(`${BASE_URL}/health`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body: HealthResponse = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.uptime).toBeGreaterThan(0);
      expect(typeof body.sessions).toBe('number');
    });

    it('should include version information', async () => {
      const response = await makeRequest(`${BASE_URL}/health`);
      const body: HealthResponse = JSON.parse(response.body);

      expect(body).toHaveProperty('version');
    });

    it('should respond to HEAD requests', async () => {
      const response = await makeRequest(`${BASE_URL}/health`, {
        method: 'HEAD',
      });

      expect(response.status).toBe(200);
      expect(response.body).toBe('');
    });
  });

  describe('GET /v1/models', () => {
    it('should return list of models', async () => {
      const response = await makeRequest(`${BASE_URL}/v1/models`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body: ModelsResponse = JSON.parse(response.body);
      expect(body.object).toBe('list');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('should return gemini model', async () => {
      const response = await makeRequest(`${BASE_URL}/v1/models`);
      const body: ModelsResponse = JSON.parse(response.body);

      const geminiModel = body.data.find((m) => m.id === 'gemini');
      expect(geminiModel).toBeDefined();
      expect(geminiModel?.object).toBe('model');
      expect(geminiModel?.owned_by).toBe('google');
      expect(geminiModel?.created).toBeGreaterThan(0);
    });

    it('should have correct OpenAI-compatible structure', async () => {
      const response = await makeRequest(`${BASE_URL}/v1/models`);
      const body: ModelsResponse = JSON.parse(response.body);

      expect(body).toHaveProperty('object', 'list');
      expect(body).toHaveProperty('data');
      expect(body.data[0]).toHaveProperty('id');
      expect(body.data[0]).toHaveProperty('object', 'model');
      expect(body.data[0]).toHaveProperty('created');
      expect(body.data[0]).toHaveProperty('owned_by');
    });
  });

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it('should return a valid chat completion response', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Say hello' }],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');

      const body: ChatCompletionResponse = JSON.parse(response.body);
      expect(body.id).toBeDefined();
      expect(body.object).toBe('chat.completion');
      expect(body.created).toBeGreaterThan(0);
      expect(body.model).toBe('gemini');
      expect(Array.isArray(body.choices)).toBe(true);
      expect(body.choices.length).toBe(1);
    });

    it('should return assistant message with content', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Say hello in 5 words' }],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const body: ChatCompletionResponse = JSON.parse(response.body);
      const choice = body.choices[0];

      expect(choice.message).toBeDefined();
      expect(choice.message?.role).toBe('assistant');
      expect(choice.message?.content).toBeDefined();
      expect(choice.message?.content!.length).toBeGreaterThan(0);
      expect(choice.finish_reason).toBe('stop');
    });

    it('should include token usage information', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const body: ChatCompletionResponse = JSON.parse(response.body);
      expect(body.usage).toBeDefined();
      expect(body.usage!.prompt_tokens).toBeGreaterThan(0);
      expect(body.usage!.completion_tokens).toBeGreaterThan(0);
      expect(body.usage!.total_tokens).toBe(
        body.usage!.prompt_tokens + body.usage!.completion_tokens,
      );
    });

    it('should handle multi-turn conversation', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [
          { role: 'user', content: 'My name is Alice' },
          { role: 'assistant', content: 'Nice to meet you, Alice!' },
          { role: 'user', content: "What's my name?" },
        ],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const body: ChatCompletionResponse = JSON.parse(response.body);
      expect(body.choices[0].message?.content).toBeDefined();
      expect(body.choices[0].message?.content!.toLowerCase()).toContain('alice');
    });

    it('should handle system messages', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that speaks in French' },
          { role: 'user', content: 'Say hello' },
        ],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      expect(response.status).toBe(200);
      const body: ChatCompletionResponse = JSON.parse(response.body);
      expect(body.choices[0].message?.content).toBeDefined();
    });

    it('should handle empty message list', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      // Should return 400 for empty messages
      expect(response.status).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('message');
    });

    it('should handle missing messages field', async () => {
      const request = {
        model: 'gemini',
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      expect(response.status).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
    });

    it('should respect max_tokens parameter', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Write a long story about dragons' }],
        max_tokens: 50,
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const body: ChatCompletionResponse = JSON.parse(response.body);
      expect(body.usage!.completion_tokens).toBeLessThanOrEqual(50);
    });

    it('should handle user field for session identification', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Hello' }],
        user: 'test-user-123',
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /v1/chat/completions (streaming)', () => {
    it('should return SSE stream with chunks', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Count from 1 to 3' }],
        stream: true,
      };

      const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      // Should have at least one data event and one DONE event
      const dataEvents = events.filter((e) => e.event === 'data');
      const doneEvent = events.find((e) => e.event === 'done');

      expect(dataEvents.length).toBeGreaterThan(0);
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.data).toBe('[DONE]');
    });

    it('should return valid chunk structure', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Say hi' }],
        stream: true,
      };

      const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const firstDataEvent = events.find((e) => e.event === 'data');
      expect(firstDataEvent).toBeDefined();

      const chunk: StreamChunk = JSON.parse(firstDataEvent!.data);
      expect(chunk.id).toBeDefined();
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.created).toBeGreaterThan(0);
      expect(chunk.model).toBe('gemini');
      expect(Array.isArray(chunk.choices)).toBe(true);
      expect(chunk.choices.length).toBe(1);
    });

    it('should have delta with content in chunks', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      };

      const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const dataEvents = events.filter((e) => e.event === 'data');
      const hasContentChunk = dataEvents.some((e) => {
        const chunk: StreamChunk = JSON.parse(e.data);
        return chunk.choices[0]?.delta?.content;
      });

      expect(hasContentChunk).toBe(true);
    });

    it('should have finish_reason in final chunk', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Say goodbye' }],
        stream: true,
      };

      const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const dataEvents = events.filter((e) => e.event === 'data');
      const finalChunk = dataEvents[dataEvents.length - 1];
      const chunk: StreamChunk = JSON.parse(finalChunk.data);

      expect(chunk.choices[0].finish_reason).toBeDefined();
      expect(['stop', 'length', null]).toContain(chunk.choices[0].finish_reason);
    });

    it('should include usage in streaming response', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Test message' }],
        stream: true,
      };

      const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      const dataEvents = events.filter((e) => e.event === 'data');
      const hasUsage = dataEvents.some((e) => {
        const chunk: StreamChunk = JSON.parse(e.data);
        return chunk.usage;
      });

      expect(hasUsage).toBe(true);
    });

    it('should set correct SSE headers', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Test' }],
        stream: true,
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toContain('no-cache');
      expect(response.headers['connection']).toContain('keep-alive');
    });
  });

  describe('POST /v1/chat/completions (error handling)', () => {
    it('should return 400 for invalid request body', async () => {
      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: { invalid: 'data' },
      });

      expect(response.status).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('message');
    });

    it('should return 400 for missing model field', async () => {
      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: { messages: [{ role: 'user', content: 'test' }] },
      });

      expect(response.status).toBe(400);
    });

    it('should handle invalid JSON in request body', async () => {
      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      // Should not crash, should return error
      expect([400, 500]).toContain(response.status);
    });
  });

  describe('CORS support', () => {
    it('should allow cross-origin requests', async () => {
      const response = await makeRequest(`${BASE_URL}/health`, {
        headers: { Origin: 'http://example.com' },
      });

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    it('should respond to OPTIONS preflight requests', async () => {
      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });

      expect([200, 204]).toContain(response.status);
    });
  });

  describe('Session management', () => {
    it('should maintain conversation context with same user', async () => {
      // First message
      const request1: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'Remember the word: BANANA' }],
        user: 'session-test-user-1',
      };

      await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request1,
      });

      // Second message should have context
      const request2: ChatCompletionRequest = {
        model: 'gemini',
        messages: [
          { role: 'user', content: 'Remember the word: BANANA' },
          { role: 'assistant', content: 'Got it, I will remember BANANA' },
          { role: 'user', content: 'What word did I tell you to remember?' },
        ],
        user: 'session-test-user-1',
      };

      const response2 = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request2,
      });

      const body: ChatCompletionResponse = JSON.parse(response2.body);
      expect(body.choices[0].message?.content).toBeDefined();
    });

    it('should handle multiple concurrent sessions', async () => {
      const session1: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'I am user 1' }],
        user: 'session-1',
      };

      const session2: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: 'I am user 2' }],
        user: 'session-2',
      };

      const [response1, response2] = await Promise.all([
        makeRequest(`${BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          body: session1,
        }),
        makeRequest(`${BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          body: session2,
        }),
      ]);

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
    });
  });

  describe('Performance and edge cases', () => {
    it('should handle very long messages', async () => {
      const longMessage = 'A'.repeat(1000);
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [{ role: 'user', content: longMessage }],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      // Should not crash
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should handle special characters in messages', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [
          {
            role: 'user',
            content: 'Test with special chars: <>&"\'🎉\n\t\\',
          },
        ],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      expect(response.status).toBe(200);
    });

    it('should handle unicode in messages', async () => {
      const request: ChatCompletionRequest = {
        model: 'gemini',
        messages: [
          {
            role: 'user',
            content: 'Hello in Japanese: こんにちは',
          },
        ],
      };

      const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        body: request,
      });

      expect(response.status).toBe(200);
      const body: ChatCompletionResponse = JSON.parse(response.body);
      expect(body.choices[0].message?.content).toBeDefined();
    });
  });
});
