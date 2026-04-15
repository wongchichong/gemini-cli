/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part, FunctionCall } from '@google/gemini-cli-core';
import type {
  ChatMessage,
  OpenAITool,
  ToolCall,
} from './openai-types.js';

/**
 * Convert OpenAI messages array to Gemini Content[] format
 * Handles role mapping and content conversion
 */
export function openAiToGeminiMessages(messages: ChatMessage[]): Content[] {
  const geminiContents: Content[] = [];
  
  for (const msg of messages) {
    const parts: Part[] = [];
    
    // Handle text content
    if (msg.content) {
      parts.push({ text: msg.content });
    }
    
    // Handle tool calls from assistant (functionCall in Gemini)
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args,
            },
          });
        } catch (e) {
          // If arguments can't be parsed, use empty object
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: {},
            },
          });
        }
      }
    }
    
    // Handle tool results (functionResponse in Gemini)
    if (msg.role === 'tool' && msg.tool_call_id) {
      parts.push({
        functionResponse: {
          name: msg.name || 'unknown',
          response: {
            result: msg.content,
            name: msg.name || 'unknown',
          },
        },
      });
    }
    
    // Map roles:
    // - system -> user (Gemini doesn't have separate system role in conversation)
    // - tool -> user (tool results are user messages in Gemini)
    // - user -> user
    // - assistant -> model
    const role = msg.role === 'system' || msg.role === 'tool' ? 'user' : msg.role;
    
    if (parts.length > 0) {
      geminiContents.push({
        role: role as 'user' | 'model',
        parts,
      });
    }
  }
  
  return geminiContents;
}

/**
 * Extract text content from Gemini parts array
 */
export function geminiToOpenAIText(parts: Part[]): string {
  return parts
    .filter((p): p is Part & { text: string } => 'text' in p && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/**
 * Convert Gemini function calls to OpenAI tool calls format
 */
export function geminiToOpenAIToolCalls(parts: Part[], callIdPrefix: string = 'call'): ToolCall[] | undefined {
  const functionCalls = parts.filter(
    (p): p is Part & { functionCall: FunctionCall } => 'functionCall' in p && !!p.functionCall
  );
  
  if (functionCalls.length === 0) return undefined;
  
  return functionCalls.map((fc, index) => ({
    id: `${callIdPrefix}_${index}`,
    type: 'function' as const,
    function: {
      name: fc.functionCall.name || 'unknown',
      arguments: JSON.stringify(fc.functionCall.args || {}),
    },
  }));
}

/**
 * Convert Gemini function declarations to OpenAI tool format
 */
export function geminiToOpenAITools(functionDeclarations: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>): OpenAITool[] {
  return functionDeclarations.map((fd) => ({
    type: 'function' as const,
    function: {
      name: fd.name,
      description: fd.description,
      parameters: fd.parameters,
    },
  }));
}

/**
 * Determine finish reason from Gemini response
 */
export function getFinishReason(finishReason?: string): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  if (!finishReason) return 'stop';
  
  switch (finishReason.toLowerCase()) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
    case 'length':
      return 'length';
    case 'tool_use':
    case 'function_call':
      return 'tool_calls';
    case 'safety':
    case 'blocklist':
    case 'recitation':
      return 'content_filter';
    default:
      return 'stop';
  }
}
