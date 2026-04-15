# Gemini CLI - OpenAI-Compatible API Server (--serve mode)

## Project Overview

The Gemini CLI is a TypeScript monorepo that provides an interactive command-line interface for Google's Gemini AI model. The project includes:

- **Interactive TUI** (default mode) - React-based terminal UI using Ink
- **Non-interactive mode** (`--prompt`) - Headless single-request execution
- **ACP mode** (`--acp`) - Agent Client Protocol for external integrations
- **A2A Server** (`packages/a2a-server`) - Existing Express server implementing Agent-to-Agent protocol

## Implementation Plan: `--serve` Mode

### Objective
Add a `--serve` flag that starts the Gemini CLI as a daemon process exposing an OpenAI-compatible REST API endpoint, enabling any OpenAI SDK client to interact with Gemini AI through this proxy server.

### Key Design Decisions

1. **OpenAI Compatibility**: Implement `/v1/chat/completions` endpoint matching OpenAI's API spec
2. **Leverage Existing Code**: Reuse the core AI interaction layer (`GeminiClient`) and non-interactive execution pattern
3. **Express Server**: Use Express 5 (already available in project dependencies)
4. **Streaming Support**: Support both streaming (SSE) and non-streaming responses
5. **Session Management**: Support multi-turn conversations via session IDs
6. **Tool Calling**: Convert between OpenAI function calling format and Gemini tool format

---

## Architecture

### File Structure (Proposed)

```
packages/cli/
├── src/
│   ├── serve/
│   │   ├── server.ts           # Express app creation and route handlers
│   │   ├── openai-types.ts     # OpenAI API type definitions
│   │   ├── converters.ts       # OpenAI <-> Gemini format converters
│   │   ├── session-manager.ts  # Session/conversation management
│   │   └── middleware.ts       # Auth, CORS, validation middleware
│   └── gemini.tsx              # Modified to add --serve mode branching

packages/cli/package.json       # Add express dependency
```

### Data Flow

```
OpenAI Client Request
    ↓
POST /v1/chat/completions
    ↓
[Converters] OpenAI messages → Gemini Content[]
    ↓
[Session Manager] Get/create GeminiClient for session
    ↓
[GeminiClient] sendMessageStream()
    ↓
[Converters] Gemini events → OpenAI SSE format
    ↓
Response (streaming or complete)
```

---

## Implementation Tasks

### Phase 1: CLI Argument and Mode Addition

#### 1.1 Add `--serve` CLI Argument

**File**: `packages/cli/src/config/config.ts`

Add to `CliArgs` interface (around line 77):
```typescript
export interface CliArgs {
  // ... existing fields ...
  serve?: boolean;              // NEW: Start as API server
  servePort?: number;           // NEW: Port for API server (default: 3000)
  serveHost?: string;           // NEW: Host for API server (default: localhost)
}
```

Add yargs option (in `parseArguments()` function, around line 264):
```typescript
.option('serve', {
  type: 'boolean',
  description: 'Start as OpenAI-compatible API server (daemon mode)',
  default: false,
})
.option('servePort', {
  type: 'number',
  description: 'Port for API server when using --serve',
  default: 3000,
})
.option('serveHost', {
  type: 'string',
  description: 'Host for API server when using --serve',
  default: 'localhost',
})
```

#### 1.2 Add Mode Branching in gemini.tsx

**File**: `packages/cli/src/gemini.tsx`

In the `main()` function, after config loading (around line 648), add branching:

```typescript
// Mode branching order:
// 1. ACP mode
// 2. Serve mode (NEW)
// 3. Interactive mode
// 4. Non-interactive mode

if (argv.acp || argv.experimentalAcp) {
  await runAcpClient(config, argv);
  return;
}

// NEW: Serve mode
if (argv.serve) {
  const { runServer } = await import('./serve/server.js');
  await runServer(config, {
    port: argv.servePort ?? 3000,
    host: argv.serveHost ?? 'localhost',
  });
  return;
}

if (config.isInteractive()) {
  await startInteractiveUI(config, argv, resumedSessionData, workspaceRoot);
} else {
  await runNonInteractive(config, argv);
}
```

---

### Phase 2: Core Server Implementation

#### 2.1 Express Server Setup

**File**: `packages/cli/src/serve/server.ts`

```typescript
import express, { type Request, type Response } from 'express';
import { createSessionManager } from './session-manager.js';
import { handleChatCompletions } from './routes/chat.js';
import { authMiddleware } from './middleware.js';

export interface ServerOptions {
  port: number;
  host: string;
  apiKey?: string;           // Optional API key for authentication
}

export async function runServer(config: Config, options: ServerOptions): Promise<void> {
  const app = express();
  
  // Middleware
  app.use(express.json());
  if (options.apiKey) {
    app.use(authMiddleware(options.apiKey));
  }
  
  // Session manager (manages GeminiClient instances per session)
  const sessionManager = createSessionManager(config);
  
  // Routes
  app.post('/v1/chat/completions', (req, res) => 
    handleChatCompletions(req, res, sessionManager));
  
  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  
  // Start server
  app.listen(options.port, options.host, () => {
    console.log(`Gemini CLI API server running on http://${options.host}:${options.port}`);
    console.log(`OpenAI-compatible endpoint: http://${options.host}:${options.port}/v1/chat/completions`);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
  
  // Keep process alive
  return new Promise(() => {}); // Never resolves
}
```

#### 2.2 Session Manager

**File**: `packages/cli/src/serve/session-manager.ts`

```typescript
import { GeminiClient, Config, Content } from '@google/gemini-cli-core';

export interface Session {
  id: string;
  client: GeminiClient;
  history: Content[];
  createdAt: Date;
  lastAccessed: Date;
}

export interface SessionManager {
  getOrCreateSession(sessionId: string): Session;
  getSession(sessionId: string): Session | undefined;
  deleteSession(sessionId: string): void;
  cleanupExpiredSessions(): void;
}

export function createSessionManager(config: Config): SessionManager {
  const sessions = new Map<string, Session>();
  
  return {
    getOrCreateSession(sessionId: string): Session {
      if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastAccessed = new Date();
        return session;
      }
      
      // Create new client and session
      const client = config.getGeminiClient();
      const session: Session = {
        id: sessionId,
        client,
        history: [],
        createdAt: new Date(),
        lastAccessed: new Date(),
      };
      sessions.set(sessionId, session);
      return session;
    },
    
    getSession(sessionId: string): Session | undefined {
      return sessions.get(sessionId);
    },
    
    deleteSession(sessionId: string): void {
      sessions.delete(sessionId);
    },
    
    cleanupExpiredSessions(): void {
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      for (const [id, session] of sessions) {
        if (now - session.lastAccessed.getTime() > maxAge) {
          sessions.delete(id);
        }
      }
    },
  };
}
```

---

### Phase 3: OpenAI API Implementation

#### 3.1 Type Definitions

**File**: `packages/cli/src/serve/openai-types.ts`

```typescript
// OpenAI Chat Completion types

export interface ChatCompletionRequest {
  model: string;                              // Model identifier (ignored, but required)
  messages: ChatMessage[];                    // Conversation history
  temperature?: number;                       // 0-2, default 1
  top_p?: number;                            // 0-1, default 1
  n?: number;                                // Number of completions (always 1)
  stream?: boolean;                          // Enable streaming
  stop?: string | string[];                  // Stop sequences
  max_tokens?: number;                       // Max tokens in response
  tools?: OpenAITool[];                      // Function calling tools
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  user?: string;                             // User identifier
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;      // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;                        // JSON string
  };
}

// Response types

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

export interface Choice {
  index: number;
  message?: ChatMessage;
  delta?: Delta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface Delta {
  role?: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCallDelta[];
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Streaming response (SSE events)

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: StreamChoice[];
}

export interface StreamChoice {
  index: number;
  delta: Delta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}
```

#### 3.2 Format Converters

**File**: `packages/cli/src/serve/converters.ts`

```typescript
import { Content, Part, FunctionCall, FunctionResponse } from '@google/gemini-cli-core';
import type {
  ChatMessage,
  OpenAITool,
  ToolCall,
} from './openai-types.js';

/**
 * Convert OpenAI messages to Gemini Content format
 */
export function openAiToGeminiMessages(messages: ChatMessage[]): Content[] {
  const geminiContents: Content[] = [];
  
  for (const msg of messages) {
    const parts: Part[] = [];
    
    // Handle text content
    if (msg.content) {
      parts.push({ text: msg.content });
    }
    
    // Handle tool calls (assistant -> tool conversion)
    if (msg.tool_calls) {
      for (const toolCall of msg.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args,
          },
        });
      }
    }
    
    // Handle tool results
    if (msg.role === 'tool' && msg.tool_call_id) {
      parts.push({
        functionResponse: {
          name: msg.name || 'unknown',
          response: {
            result: msg.content,
          },
        },
      });
    }
    
    // Map roles: system/instruction -> user (Gemini doesn't have system in same way)
    const role = msg.role === 'system' ? 'user' : 
                 msg.role === 'tool' ? 'user' : 
                 msg.role;
    
    geminiContents.push({
      role: role as 'user' | 'model',
      parts,
    });
  }
  
  return geminiContents;
}

/**
 * Convert Gemini text content to OpenAI format
 */
export function geminiToOpenAIText(parts: Part[]): string {
  return parts
    .filter((p): p is Part & { text: string } => 'text' in p && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/**
 * Convert Gemini function calls to OpenAI tool calls
 */
export function geminiToOpenAIToolCalls(parts: Part[]): ToolCall[] | undefined {
  const functionCalls = parts.filter(
    (p): p is Part & { functionCall: FunctionCall } => 'functionCall' in p
  );
  
  if (functionCalls.length === 0) return undefined;
  
  return functionCalls.map((fc, index) => ({
    id: `call_${index}`,
    type: 'function' as const,
    function: {
      name: fc.functionCall.name,
      arguments: JSON.stringify(fc.functionCall.args),
    },
  }));
}

/**
 * Convert Gemini tools to OpenAI tool format
 */
export function geminiToOpenAITools(functionDeclarations: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}[]): OpenAITool[] {
  return functionDeclarations.map((fd) => ({
    type: 'function' as const,
    function: fd,
  }));
}
```

#### 3.3 Route Handler

**File**: `packages/cli/src/serve/routes/chat.ts`

```typescript
import { type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { SessionManager } from '../session-manager.js';
import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk } from '../openai-types.js';
import { openAiToGeminiMessages, geminiToOpenAIText, geminiToOpenAIToolCalls } from '../converters.js';
import { ServerGeminiStreamEvent, GeminiEventType } from '@google/gemini-cli-core';

export async function handleChatCompletions(
  req: Request,
  res: Response,
  sessionManager: SessionManager
): Promise<void> {
  try {
    const request: ChatCompletionRequest = req.body;
    
    // Validate request
    if (!request.messages || request.messages.length === 0) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }
    
    // Get or create session
    const sessionId = request.user || uuidv4();
    const session = sessionManager.getOrCreateSession(sessionId);
    
    // Convert messages
    const geminiMessages = openAiToGeminiMessages(request.messages);
    
    if (request.stream) {
      // Streaming response
      await handleStreamingResponse(req, res, session, geminiMessages, request);
    } else {
      // Non-streaming response
      await handleNonStreamingResponse(res, session, geminiMessages, request);
    }
  } catch (error) {
    console.error('Error in /v1/chat/completions:', error);
    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
        type: 'api_error',
      },
    });
  }
}

async function handleStreamingResponse(
  req: Request,
  res: Response,
  session: any,
  geminiMessages: any[],
  request: ChatCompletionRequest
): Promise<void> {
  const completionId = `chatcmpl-${uuidv4()}`;
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  let fullContent = '';
  let toolCalls: any[] = [];
  let finishReason: string | null = null;
  
  try {
    // Get event stream from Gemini client
    const stream = session.client.sendMessageStream(geminiMessages);
    
    for await (const event of stream) {
      const chunk: StreamChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gemini',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: null,
        }],
      };
      
      // Handle different event types
      if (event.type === GeminiEventType.Content) {
        const text = event.text;
        fullContent += text;
        chunk.choices[0].delta = { content: text };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } else if (event.type === GeminiEventType.ToolCallRequest) {
        const toolCall = {
          index: toolCalls.length,
          id: `call_${toolCalls.length}`,
          type: 'function',
          function: {
            name: event.functionName,
            arguments: JSON.stringify(event.args),
          },
        };
        toolCalls.push(toolCall);
        chunk.choices[0].delta = { tool_calls: [toolCall] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
    
    // Send final chunk with finish reason
    chunk.choices[0].finish_reason = finishReason || 'stop';
    chunk.choices[0].delta = {};
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    
    // Send [DONE] marker
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
}

async function handleNonStreamingResponse(
  res: Response,
  session: any,
  geminiMessages: any[],
  request: ChatCompletionRequest
): Promise<void> {
  let fullContent = '';
  let toolCalls: any[] = [];
  let finishReason = 'stop';
  
  // Get full response
  const stream = session.client.sendMessageStream(geminiMessages);
  
  for await (const event of stream) {
    if (event.type === GeminiEventType.Content) {
      fullContent += event.text;
    } else if (event.type === GeminiEventType.ToolCallRequest) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: event.functionName,
          arguments: JSON.stringify(event.args),
        },
      });
      finishReason = 'tool_calls';
    }
  }
  
  const response: ChatCompletionResponse = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gemini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: fullContent || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: finishReason,
    }],
  };
  
  res.json(response);
}
```

#### 3.4 Middleware

**File**: `packages/cli/src/serve/middleware.ts`

```typescript
import { type Request, type Response, type NextFunction } from 'express';

export interface AuthMiddlewareOptions {
  apiKey: string;
}

/**
 * API key authentication middleware
 */
export function authMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          message: 'Invalid or missing API key',
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
 */
export function corsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    
    next();
  };
}

/**
 * Request validation middleware
 */
export function validateChatRequest(req: Request, res: Response, next: NextFunction) {
  const body = req.body;
  
  if (!body.messages || !Array.isArray(body.messages)) {
    res.status(400).json({
      error: {
        message: 'messages field is required and must be an array',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  
  // Validate message roles
  for (const msg of body.messages) {
    if (!msg.role || !['system', 'user', 'assistant', 'tool'].includes(msg.role)) {
      res.status(400).json({
        error: {
          message: 'Invalid message role. Must be: system, user, assistant, or tool',
          type: 'invalid_request_error',
        },
      });
      return;
    }
  }
  
  next();
}
```

---

### Phase 4: Dependencies and Configuration

#### 4.1 Add Dependencies

**File**: `packages/cli/package.json`

Add to dependencies:
```json
{
  "dependencies": {
    "express": "^5.1.0",
    "@types/express": "^5.0.3",
    "uuid": "^13.0.0"
  }
}
```

Note: These may already be available via the a2a-server package. If pnpm workspaces are properly configured, they may not need to be added to CLI package.

---

### Phase 5: Features and Enhancements

#### 5.1 Tool/Function Calling Support

The server should support OpenAI's function calling format and convert it to Gemini's tool format:

1. Accept `tools[]` parameter in request
2. Convert to Gemini function declarations
3. Pass to Gemini client
4. Convert function call results back to OpenAI format
5. Support `tool_choice` parameter

#### 5.2 Model Selection

Since this is a proxy to Gemini, the `model` parameter in requests will be acknowledged but the actual model used will be determined by the CLI configuration. Optionally support model mapping:

```typescript
const MODEL_MAP: Record<string, string> = {
  'gpt-3.5-turbo': 'gemini-flash',
  'gpt-4': 'gemini-pro',
  'gpt-4-turbo': 'gemini-pro',
};
```

#### 5.3 Session Persistence

Implement optional session persistence to disk:
- Store conversations in `~/.gemini/sessions/`
- Allow resuming conversations via session ID
- Implement session cleanup for expired sessions

#### 5.4 Usage Tracking

Track API usage:
- Request count
- Token usage (if available from Gemini API)
- Error rates

## Authentication Model

### Shared Authentication

**YES -- `--serve` shares the same auth as the regular CLI.** 

When you run `gemini /auth login` (or set up API keys), the credentials are stored in:
- **OS Keychain** (primary): Native secure storage (`gemini-cli-oauth` service)
- **Encrypted file** (fallback): `~/.gemini/oauth_creds.json`

When you later run `gemini --serve`, it will:
1. Use the **same credential storage** (keychain/file)
2. Read the **same environment variables** (`GEMINI_API_KEY`, etc.)
3. Use the **same `Config` class** and auth detection logic
4. Create the **same `ContentGenerator`** with identical auth

**There is NO separate authentication for server mode.** The auth is global across all modes:
- Interactive TUI (default)
- Non-interactive (`--prompt`)
- ACP mode (`--acp`)
- **Server mode (`--serve`)** ← NEW
- A2A Server (existing)

### Auth Types Supported

| Auth Type | Detection | Credential Source |
|-----------|-----------|-------------------|
| `LOGIN_WITH_GOOGLE` | `GOOGLE_GENAI_USE_GCA=true` | OAuth2 tokens in keychain |
| `USE_GEMINI` | `GEMINI_API_KEY` env var | API key from env or keychain |
| `USE_VERTEX_AI` | `GOOGLE_GENAI_USE_VERTEXAI=true` | Google Cloud credentials |
| `COMPUTE_ADC` | `CLOUD_SHELL=true` | GCE metadata server |

### Two-Layer Auth Model

The `--serve` mode has **two separate authentication layers**:

#### Layer 1: Gemini AI Auth (Internal)
- **Purpose**: Authenticate WITH Google/Gemini API to access AI models
- **Source**: Shared with CLI (keychain, env vars, settings)
- **Setup**: `gemini /auth login` or `GEMINI_API_KEY=xxx`
- **Used by**: The server process to call Gemini API

#### Layer 2: Server API Auth (External)
- **Purpose**: Protect your `/v1/chat/completions` endpoint from unauthorized access
- **Source**: Custom API key you set for the server
- **Setup**: `--serve-api-key your-secret-key` or settings
- **Used by**: Clients calling your server (OpenAI SDK, curl, etc.)

**Example:**
```bash
# You logged in with Google for CLI
gemini /auth login

# Start server - uses SAME Google auth for Gemini API
gemini --serve --serve-api-key my-secret-key

# Client must provide your server API key
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

The server API key (Layer 2) is **optional** - you can run the server without it for local development, but should use it in production to protect your endpoint.

### Implementation Note

The server implementation should:
1. Call `validateNonInteractiveAuth()` at startup (same as `--prompt` mode)
2. Create ContentGenerator using the same pipeline as CLI
3. Optionally add API key middleware for protecting the HTTP endpoint
4. **NOT** require separate Gemini AI credentials - reuses CLI auth entirely

---

## Integration with Existing Code

### Reusing Non-Interactive Flow

The existing `runNonInteractive()` function in `packages/cli/src/nonInteractiveCli.ts` provides a pattern for executing requests without the TUI. The server implementation should follow a similar pattern:

1. Load config (authentication, model, tools, etc.)
2. Create Gemini client
3. Execute request with streaming
4. Format output (SSE instead of stdout)

### Reusing A2A Server Patterns

The A2A server (`packages/a2a-server`) already implements:
- Express server setup
- Streaming via SSE
- Task/session management
- Tool execution loop

Reference these patterns but adapt for OpenAI compatibility.

---

## API Specification

### Endpoints

#### POST /v1/chat/completions

Create a chat completion (OpenAI compatible)

**Request Body**:
```json
{
  "model": "gemini",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant"},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1000
}
```

**Response (non-streaming)**:
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gemini",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}
```

**Response (streaming)**:
```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"gemini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"gemini","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

#### GET /health

Health check endpoint

**Response**:
```json
{"status": "ok", "version": "0.39.0"}
```

#### GET /v1/models

List available models (optional, for compatibility)

**Response**:
```json
{
  "object": "list",
  "data": [{
    "id": "gemini",
    "object": "model",
    "created": 1234567890,
    "owned_by": "google"
  }]
}
```

---

## Testing Strategy

### Unit Tests

1. **Converters**: Test OpenAI <-> Gemini format conversions
2. **Session Manager**: Test session creation, retrieval, cleanup
3. **Middleware**: Test auth, CORS, validation

### Integration Tests

1. **Server Startup**: Test server starts correctly
2. **Chat Completions**: Test complete request/response cycle
3. **Streaming**: Test SSE streaming works correctly
4. **Tool Calling**: Test function calling conversion
5. **Error Handling**: Test error responses

### Manual Testing

```bash
# Start server
gemini --serve --serve-port 3000

# Test with curl
curl http://localhost:3000/health

# Test chat completion
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini",
    "messages": [{"role": "user", "content": "Say hello!"}]
  }'

# Test streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini",
    "messages": [{"role": "user", "content": "Say hello!"}],
    "stream": true
  }'

# Test with OpenAI SDK (Python)
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="gemini",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

---

## Progress Tracking

### Completed
- [ ] Architectural analysis
- [ ] Implementation plan creation
- [ ] CLAUDE.md creation

### Phase 1: CLI Integration
- [ ] Add `--serve`, `--serve-port`, `--serve-host` CLI arguments
- [ ] Add mode branching in `gemini.tsx`
- [ ] Test CLI argument parsing

### Phase 2: Server Core
- [ ] Create Express server setup
- [ ] Implement session manager
- [ ] Add health check endpoint
- [ ] Test server startup and basic routes

### Phase 3: OpenAI API
- [ ] Implement type definitions
- [ ] Implement format converters
- [ ] Implement `/v1/chat/completions` route
- [ ] Add streaming support (SSE)
- [ ] Add non-streaming support
- [ ] Test basic chat completion

### Phase 4: Advanced Features
- [ ] Implement tool/function calling
- [ ] Add API key authentication
- [ ] Add CORS middleware
- [ ] Implement session persistence
- [ ] Add `/v1/models` endpoint

### Phase 5: Testing and Polish
- [ ] Write unit tests for converters
- [ ] Write integration tests for server
- [ ] Test with OpenAI SDK clients
- [ ] Add error handling and logging
- [ ] Update documentation
- [ ] Handle edge cases (empty responses, max tokens, etc.)

---

## Known Challenges

1. **Tool Execution in Server Context**: The CLI's tool execution assumes local filesystem access. In server mode, tools like `shell` need careful consideration for security.

2. **State Management**: Multi-turn conversations require maintaining client state and history correctly.

3. **Streaming Error Handling**: SSE streaming errors need graceful handling without breaking the connection.

4. **Token Counting**: OpenAI responses include token usage. Gemini API may provide this differently or not at all.

5. **Model Compatibility**: Not all Gemini features map cleanly to OpenAI's API format.

6. **Security**: Server mode exposes AI capabilities over HTTP. Need proper authentication, rate limiting, and input validation.

---

## References

- OpenAI Chat Completions API: https://platform.openai.com/docs/api-reference/chat
- Gemini API Documentation: https://ai.google.dev/docs
- Existing A2A Server: `packages/a2a-server/src/http/app.ts`
- Non-Interactive CLI Flow: `packages/cli/src/nonInteractiveCli.ts`
- Gemini Client: `packages/core/src/core/client.ts`

---

## Notes for Implementation

- Use `pnpm` for package management (this is a pnpm workspace)
- Run `pnpm build` after making changes
- Run `pnpm start` to test interactive mode
- Run `pnpm start -- --serve` to test server mode
- All TypeScript files must use `.ts` or `.tsx` extension
- Use `.js` extensions in import statements (TypeScript will resolve)
- Follow existing code style and licensing (Apache 2.0)
- Add tests for all new functionality
