/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { Config, Content, Part } from '@google/gemini-cli-core';
import { GeminiEventType } from '@google/gemini-cli-core';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ToolCall,
  Usage,
} from '../openai-types.js';
import {
  openAiToGeminiMessages,
  getFinishReason,
} from '../converters.js';
import type { Session, SessionManager } from '../session-manager.js';

/**
 * Handle POST /v1/chat/completions
 * Supports both streaming and non-streaming responses
 */
export async function handleChatCompletions(
  req: Request,
  res: Response,
  config: Config,
  sessionManager: SessionManager
): Promise<void> {
  try {
    const request: ChatCompletionRequest = req.body;
    
    // Get or create session (use request.user as session ID if provided)
    const session = sessionManager.getOrCreateSession(request.user);
    
    // Convert OpenAI messages to Gemini format
    const geminiMessages = openAiToGeminiMessages(request.messages);
    
    // Update session history
    session.history = geminiMessages;
    session.messageCount += request.messages.length;
    
    if (request.stream) {
      // Streaming response via Server-Sent Events
      await handleStreamingResponse(req, res, config, session, request, sessionManager);
    } else {
      // Non-streaming response
      await handleNonStreamingResponse(res, config, session, request, sessionManager);
    }
  } catch (error) {
    console.error('[Serve] Error in /v1/chat/completions:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          type: 'api_error',
        },
      });
    }
  }
}

/**
 * Handle streaming response using Server-Sent Events (SSE)
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  config: Config,
  session: Session,
  request: ChatCompletionRequest,
  sessionManager: SessionManager
): Promise<void> {
  const completionId = `chatcmpl-${uuidv4()}`;
  
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
  
  let fullContent = '';
  const toolCalls: ToolCall[] = [];
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = null;
  let usage: Usage | undefined;
  
  try {
    // Get the Gemini client from config
    const client = config.getGeminiClient();
    
    // Convert the last user message to parts for the request
    const lastUserMessage = session.history.length > 0 
      ? session.history[session.history.length - 1]
      : null;
    const requestParts: Part[] = lastUserMessage?.parts || [];
    
    const signal = new AbortController().signal;
    const promptId = session.id;
    const stream = client.sendMessageStream(requestParts, signal, promptId);
    
    for await (const event of stream) {
      const chunk = createStreamChunk(completionId, request.model || 'gemini');
      
      // Handle different event types
      switch (event.type) {
        case GeminiEventType.Content: {
          const text = event.value;
          fullContent += text;
          
          // Only send delta if there's actual content
          if (text) {
            chunk.choices[0].delta = { content: text };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          break;
        }
        
        case GeminiEventType.ToolCallRequest: {
          const toolCallInfo = event.value;
          const toolCall: ToolCall = {
            id: toolCallInfo.callId,
            type: 'function',
            function: {
              name: toolCallInfo.name,
              arguments: JSON.stringify(toolCallInfo.args),
            },
          };
          
          toolCalls.push(toolCall);
          
          // Send tool call in delta
          chunk.choices[0].delta = {
            tool_calls: [{
              index: toolCalls.length - 1,
              ...toolCall,
            }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          break;
        }
        
        case GeminiEventType.Finished: {
          const finishEvent = event.value;
          finishReason = getFinishReason(finishEvent?.reason);
          
          // Extract usage metadata if available
          if (finishEvent?.usageMetadata) {
            usage = {
              prompt_tokens: finishEvent.usageMetadata.promptTokenCount || 0,
              completion_tokens: finishEvent.usageMetadata.candidatesTokenCount || 0,
              total_tokens: finishEvent.usageMetadata.totalTokenCount || 0,
            };
          }
          break;
        }
        
        case GeminiEventType.Error: {
          const error = event.value?.error;
          throw new Error(error instanceof Error ? error.message : String(error));
        }
        
        case GeminiEventType.UserCancelled: {
          finishReason = 'stop';
          break;
        }
        
        // Ignore these event types for streaming
        case GeminiEventType.Thought:
        case GeminiEventType.Citation:
        case GeminiEventType.Retry:
        case GeminiEventType.ModelInfo:
        case GeminiEventType.ChatCompressed:
        case GeminiEventType.ToolCallResponse:
        case GeminiEventType.ToolCallConfirmation:
        case GeminiEventType.MaxSessionTurns:
        case GeminiEventType.LoopDetected:
        case GeminiEventType.ContextWindowWillOverflow:
        case GeminiEventType.InvalidStream:
        case GeminiEventType.AgentExecutionStopped:
        case GeminiEventType.AgentExecutionBlocked:
          break;
      }
    }
    
    // Update session with assistant response
    const assistantContent: Content[] = [{
      role: 'model',
      parts: [{ text: fullContent }],
    }];
    session.history.push(...assistantContent);
    session.lastAccessed = new Date();
    session.messageCount++;
    
    // Send final chunk with finish reason
    const finalChunk = createStreamChunk(completionId, request.model || 'gemini');
    finalChunk.choices[0].finish_reason = finishReason || 'stop';
    finalChunk.choices[0].delta = {};
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    
    // Send usage as a special final message (optional)
    if (usage) {
      const usageChunk = createStreamChunk(completionId, request.model || 'gemini');
      (usageChunk as any).usage = usage;
      res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    }
    
    // Send [DONE] marker
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    // Send error in SSE format
    const errorChunk = createStreamChunk(completionId, request.model || 'gemini');
    errorChunk.choices[0].delta = {
      content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
    };
    errorChunk.choices[0].finish_reason = 'stop';
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  config: Config,
  session: Session,
  request: ChatCompletionRequest,
  sessionManager: SessionManager
): Promise<void> {
  let fullContent = '';
  const toolCalls: ToolCall[] = [];
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null = 'stop';
  let usage: Usage | undefined;
  
  try {
    // Get the Gemini client from config
    const client = config.getGeminiClient();
    
    // Convert the last user message to parts for the request
    const lastUserMessage = session.history.length > 0 
      ? session.history[session.history.length - 1]
      : null;
    const requestParts: Part[] = lastUserMessage?.parts || [];
    
    const signal = new AbortController().signal;
    const promptId = session.id;
    const stream = client.sendMessageStream(requestParts, signal, promptId);
    
    // Consume the stream and collect all events
    for await (const event of stream) {
      switch (event.type) {
        case GeminiEventType.Content: {
          fullContent += event.value;
          break;
        }
        
        case GeminiEventType.ToolCallRequest: {
          const toolCallInfo = event.value;
          toolCalls.push({
            id: toolCallInfo.callId,
            type: 'function',
            function: {
              name: toolCallInfo.name,
              arguments: JSON.stringify(toolCallInfo.args),
            },
          });
          finishReason = 'tool_calls';
          break;
        }
        
        case GeminiEventType.Finished: {
          const finishEvent = event.value;
          finishReason = getFinishReason(finishEvent?.reason);
          
          // Extract usage metadata if available
          if (finishEvent?.usageMetadata) {
            usage = {
              prompt_tokens: finishEvent.usageMetadata.promptTokenCount || 0,
              completion_tokens: finishEvent.usageMetadata.candidatesTokenCount || 0,
              total_tokens: finishEvent.usageMetadata.totalTokenCount || 0,
            };
          }
          break;
        }
        
        case GeminiEventType.Error: {
          const error = event.value?.error;
          throw new Error(error instanceof Error ? error.message : String(error));
        }
        
        // Ignore these event types for non-streaming
        case GeminiEventType.Thought:
        case GeminiEventType.Citation:
        case GeminiEventType.Retry:
        case GeminiEventType.ModelInfo:
        case GeminiEventType.ChatCompressed:
        case GeminiEventType.ToolCallResponse:
        case GeminiEventType.ToolCallConfirmation:
        case GeminiEventType.UserCancelled:
        case GeminiEventType.MaxSessionTurns:
        case GeminiEventType.LoopDetected:
        case GeminiEventType.ContextWindowWillOverflow:
        case GeminiEventType.InvalidStream:
        case GeminiEventType.AgentExecutionStopped:
        case GeminiEventType.AgentExecutionBlocked:
          break;
      }
    }
    
    // Update session with assistant response
    const assistantContent: Content[] = [{
      role: 'model',
      parts: [{ text: fullContent }],
    }];
    session.history.push(...assistantContent);
    session.lastAccessed = new Date();
    session.messageCount++;
    
    // Build OpenAI-compatible response
    const response: ChatCompletionResponse = {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model || 'gemini',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason,
      }],
      usage,
    };
    
    res.json(response);
  } catch (error) {
    console.error('[Serve] Error processing request:', error);
    
    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
        type: 'api_error',
      },
    });
  }
}

/**
 * Helper to create a stream chunk with common fields
 */
function createStreamChunk(id: string, model: string): StreamChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: null,
    }],
  };
}
