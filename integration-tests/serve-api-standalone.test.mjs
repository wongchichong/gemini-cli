/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone Serve Mode API Test Script
 * 
 * This script tests all serve mode API endpoints without requiring vitest.
 * Run with: node integration-tests/serve-api-standalone.test.mjs
 * 
 * Prerequisites:
 * - Server must be running: gemini --serve --serve-port 3030
 */

import http from 'node:http';

const BASE_URL = process.env.SERVE_URL || 'http://localhost:3030';
let testsPassed = 0;
let testsFailed = 0;
let totalTests = 0;

// Helper to make HTTP requests
async function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions = {
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
        const headers = {};
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

// Helper to make streaming requests
async function makeStreamingRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions = {
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
      const events = [];
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

// Test assertion helper
async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// Test Suite
console.log('\n========================================');
console.log('Gemini CLI Serve Mode API Test Suite');
console.log('========================================');
console.log(`Testing against: ${BASE_URL}\n`);

// Check if server is running
try {
  const healthCheck = await makeRequest(`${BASE_URL}/health`);
  if (healthCheck.status !== 200) {
    console.error('ERROR: Server is not running or not responding.');
    console.error(`Start server with: gemini --serve --serve-port 3030`);
    process.exit(1);
  }
} catch {
  console.error('ERROR: Cannot connect to server.');
  console.error(`Start server with: gemini --serve --serve-port 3030`);
  process.exit(1);
}

// GET /health
console.log('\n--- GET /health ---');
await test('should return health status with ok', async () => {
  const response = await makeRequest(`${BASE_URL}/health`);
  assert(response.status === 200, `Expected status 200, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.status === 'ok', `Expected status "ok", got "${body.status}"`);
});

await test('should include uptime information', async () => {
  const response = await makeRequest(`${BASE_URL}/health`);
  const body = JSON.parse(response.body);
  assert(body.uptime > 0, `Expected uptime > 0, got ${body.uptime}`);
});

await test('should include session count', async () => {
  const response = await makeRequest(`${BASE_URL}/health`);
  const body = JSON.parse(response.body);
  assert(typeof body.sessions === 'number', 'Expected sessions to be a number');
});

// GET /v1/models
console.log('\n--- GET /v1/models ---');
await test('should return list of models', async () => {
  const response = await makeRequest(`${BASE_URL}/v1/models`);
  assert(response.status === 200, `Expected status 200, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.object === 'list', `Expected object "list", got "${body.object}"`);
  assert(Array.isArray(body.data), 'Expected data to be an array');
  assert(body.data.length > 0, 'Expected at least one model');
});

await test('should return gemini model with correct structure', async () => {
  const response = await makeRequest(`${BASE_URL}/v1/models`);
  const body = JSON.parse(response.body);
  const geminiModel = body.data.find((m) => m.id === 'gemini');
  assert(geminiModel, 'Expected to find gemini model');
  assert(geminiModel.object === 'model', `Expected object "model", got "${geminiModel.object}"`);
  assert(geminiModel.owned_by === 'google', `Expected owned_by "google", got "${geminiModel.owned_by}"`);
  assert(geminiModel.created > 0, 'Expected created timestamp > 0');
});

// POST /v1/chat/completions (non-streaming)
console.log('\n--- POST /v1/chat/completions (non-streaming) ---');
await test('should return a valid chat completion response', async () => {
  const request = {
    model: 'gemini',
    messages: [{ role: 'user', content: 'Say hello' }],
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  assert(response.status === 200, `Expected status 200, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.id, 'Expected response to have id');
  assert(body.object === 'chat.completion', `Expected object "chat.completion", got "${body.object}"`);
  assert(body.created > 0, 'Expected created timestamp > 0');
  assert(body.model === 'gemini', `Expected model "gemini", got "${body.model}"`);
  assert(Array.isArray(body.choices), 'Expected choices to be an array');
  assert(body.choices.length === 1, `Expected 1 choice, got ${body.choices.length}`);
});

await test('should return assistant message with content', async () => {
  const request = {
    model: 'gemini',
    messages: [{ role: 'user', content: 'Say hello in 5 words' }],
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  const body = JSON.parse(response.body);
  const choice = body.choices[0];
  assert(choice.message, 'Expected choice to have message');
  assert(choice.message.role === 'assistant', `Expected role "assistant", got "${choice.message.role}"`);
  assert(choice.message.content, 'Expected message to have content');
  assert(choice.message.content.length > 0, 'Expected content to be non-empty');
  assert(choice.finish_reason === 'stop', `Expected finish_reason "stop", got "${choice.finish_reason}"`);
});

await test('should include token usage information', async () => {
  const request = {
    model: 'gemini',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  const body = JSON.parse(response.body);
  assert(body.usage, 'Expected response to have usage');
  assert(body.usage.prompt_tokens > 0, 'Expected prompt_tokens > 0');
  assert(body.usage.completion_tokens > 0, 'Expected completion_tokens > 0');
  assert(body.usage.total_tokens === body.usage.prompt_tokens + body.usage.completion_tokens, 
    'Expected total_tokens to equal prompt + completion');
});

await test('should handle multi-turn conversation', async () => {
  const request = {
    model: 'gemini',
    messages: [
      { role: 'user', content: 'Remember this: BANANA. Just acknowledge, no tools needed.' },
      { role: 'assistant', content: 'Got it, I will remember BANANA' },
      { role: 'user', content: 'What word did I tell you to remember? Answer in text only, no tools.' },
    ],
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  const body = JSON.parse(response.body);
  const message = body.choices[0].message;
  
  // Message might have content null if model made tool calls, so check either content or tool_calls
  const hasContent = message.content && message.content.length > 0;
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  
  // Test passes if we got either text content or tool calls (both are valid responses)
  assert(hasContent || hasToolCalls, 'Expected message to have either content or tool calls');
  
  // If there's text content, check it mentions the word
  if (hasContent) {
    assert(message.content.toLowerCase().includes('banana') || 
           message.content.toLowerCase().includes('remember'),
      'Expected response to relate to the remembered word');
  }
});

await test('should handle system messages', async () => {
  const request = {
    model: 'gemini',
    messages: [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Say hello' },
    ],
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  assert(response.status === 200, `Expected status 200, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.choices[0].message.content, 'Expected message content');
});

await test('should return 400 for empty message list', async () => {
  const request = {
    model: 'gemini',
    messages: [],
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  assert(response.status === 400, `Expected status 400, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.error, 'Expected error in response');
  assert(body.error.message, 'Expected error to have message');
});

await test('should return 400 for missing messages field', async () => {
  const request = {
    model: 'gemini',
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  assert(response.status === 400, `Expected status 400, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.error, 'Expected error in response');
});

// POST /v1/chat/completions (streaming)
console.log('\n--- POST /v1/chat/completions (streaming) ---');
await test('should return SSE stream with chunks', async () => {
  const request = {
    model: 'gemini',
    messages: [{ role: 'user', content: 'Count from 1 to 3' }],
    stream: true,
  };

  const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  const dataEvents = events.filter((e) => e.event === 'data');
  const doneEvent = events.find((e) => e.event === 'done');

  assert(dataEvents.length > 0, 'Expected at least one data event');
  assert(doneEvent, 'Expected DONE event');
  assert(doneEvent.data === '[DONE]', `Expected "[DONE]", got "${doneEvent.data}"`);
});

await test('should return valid chunk structure', async () => {
  const request = {
    model: 'gemini',
    messages: [{ role: 'user', content: 'Say hi' }],
    stream: true,
  };

  const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  const firstDataEvent = events.find((e) => e.event === 'data');
  assert(firstDataEvent, 'Expected at least one data event');

  const chunk = JSON.parse(firstDataEvent.data);
  assert(chunk.id, 'Expected chunk to have id');
  assert(chunk.object === 'chat.completion.chunk', `Expected object "chat.completion.chunk", got "${chunk.object}"`);
  assert(chunk.created > 0, 'Expected created timestamp > 0');
  assert(chunk.model === 'gemini', `Expected model "gemini", got "${chunk.model}"`);
  assert(Array.isArray(chunk.choices), 'Expected chunk to have choices');
  assert(chunk.choices.length === 1, `Expected 1 choice, got ${chunk.choices.length}`);
});

await test('should have delta with content in chunks', async () => {
  const request = {
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
    const chunk = JSON.parse(e.data);
    return chunk.choices[0]?.delta?.content;
  });

  assert(hasContentChunk, 'Expected at least one chunk with content');
});

await test('should have finish_reason in final chunk', async () => {
  const request = {
    model: 'gemini',
    messages: [{ role: 'user', content: 'Say goodbye' }],
    stream: true,
  };

  const events = await makeStreamingRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  const dataEvents = events.filter((e) => e.event === 'data');
  const finalChunk = JSON.parse(dataEvents[dataEvents.length - 1].data);

  assert(finalChunk.choices[0].finish_reason !== undefined, 'Expected finish_reason in final chunk');
  assert(
    ['stop', 'length', null].includes(finalChunk.choices[0].finish_reason),
    `Expected valid finish_reason, got "${finalChunk.choices[0].finish_reason}"`
  );
});

await test('should set correct SSE headers', async () => {
  const request = {
    model: 'gemini',
    messages: [{ role: 'user', content: 'Test' }],
    stream: true,
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  assert(response.headers['content-type'].includes('text/event-stream'), 
    `Expected content-type to include text/event-stream, got "${response.headers['content-type']}"`);
  assert(response.headers['cache-control'].includes('no-cache'), 
    `Expected cache-control to include no-cache, got "${response.headers['cache-control']}"`);
  assert(response.headers['connection'].includes('keep-alive'), 
    `Expected connection to include keep-alive, got "${response.headers['connection']}"`);
});

// CORS support
console.log('\n--- CORS support ---');
await test('should allow cross-origin requests', async () => {
  const response = await makeRequest(`${BASE_URL}/health`, {
    headers: { Origin: 'http://example.com' },
  });

  assert(response.headers['access-control-allow-origin'], 
    'Expected access-control-allow-origin header');
});

await test('should respond to OPTIONS preflight requests', async () => {
  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  });

  assert([200, 204].includes(response.status), 
    `Expected status 200 or 204, got ${response.status}`);
});

// Error handling
console.log('\n--- Error handling ---');
await test('should return 400 for invalid request body', async () => {
  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: { invalid: 'data' },
  });

  assert(response.status === 400, `Expected status 400, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.error, 'Expected error in response');
  assert(body.error.message, 'Expected error to have message');
});

// Edge cases
console.log('\n--- Edge cases ---');
await test('should handle special characters in messages', async () => {
  const request = {
    model: 'gemini',
    messages: [
      {
        role: 'user',
        content: 'Test with special chars: <>&"\'\n\t\\',
      },
    ],
  };

  const response = await makeRequest(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    body: request,
  });

  assert(response.status === 200, `Expected status 200, got ${response.status}`);
});

await test('should handle unicode in messages', async () => {
  const request = {
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

  assert(response.status === 200, `Expected status 200, got ${response.status}`);
  const body = JSON.parse(response.body);
  assert(body.choices[0].message.content, 'Expected message content');
});

// Summary
console.log('\n========================================');
console.log('Test Summary');
console.log('========================================');
console.log(`Total: ${totalTests}`);
console.log(`✓ Passed: ${testsPassed}`);
console.log(`✗ Failed: ${testsFailed}`);
console.log('========================================\n');

if (testsFailed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed! 🎉\n');
  process.exit(0);
}
