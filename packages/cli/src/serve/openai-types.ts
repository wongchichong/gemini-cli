/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// OpenAI Chat Completion types for /v1/chat/completions endpoint

/**
 * Request to create a chat completion
 */
export interface ChatCompletionRequest {
  model: string;                              // Model identifier (acknowledged but CLI config determines actual model)
  messages: ChatMessage[];                    // Conversation history
  temperature?: number;                       // Sampling temperature (0-2, default 1)
  top_p?: number;                            // Nucleus sampling (0-1, default 1)
  n?: number;                                // Number of completions to generate (always 1 for now)
  stream?: boolean;                          // Enable streaming via SSE
  stop?: string | string[];                  // Stop sequences
  max_tokens?: number;                       // Maximum tokens in response
  tools?: OpenAITool[];                      // Function calling tools
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  user?: string;                             // User identifier (used as session ID)
}

/**
 * A message in the conversation
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;                             // For tool messages
  tool_calls?: ToolCall[];                   // When assistant wants to call tools
  tool_call_id?: string;                     // For tool result messages
}

/**
 * A tool definition for function calling
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;      // JSON Schema for parameters
  };
}

/**
 * A tool call made by the assistant
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;                        // JSON string of arguments
  };
}

// Response types

/**
 * Complete chat completion response (non-streaming)
 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

/**
 * A choice in the response
 */
export interface Choice {
  index: number;
  message?: ChatMessage;                     // For non-streaming
  delta?: Delta;                              // For streaming
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * Incremental update in streaming mode
 */
export interface Delta {
  role?: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCallDelta[];
}

/**
 * Tool call delta in streaming mode
 */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * Token usage information
 */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Streaming response types

/**
 * A chunk in streaming response
 */
export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: StreamChoice[];
}

/**
 * A choice in a streaming chunk
 */
export interface StreamChoice {
  index: number;
  delta: Delta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

/**
 * Error response format
 */
export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}
