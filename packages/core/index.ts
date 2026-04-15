/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './src/index.js';
export { Storage } from './src/config/storage.js';
export {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from './src/config/models.js';
export {
  serializeTerminalToObject,
  type AnsiOutput,
  type AnsiLine,
  type AnsiToken,
} from './src/utils/terminalSerializer.js';
export { DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD } from './src/config/config.js';
export { detectIdeFromEnv } from './src/ide/detect-ide.js';
export {
  logExtensionEnable,
  logIdeConnection,
  logExtensionDisable,
} from './src/telemetry/loggers.js';

export {
  IdeConnectionEvent,
  IdeConnectionType,
  ExtensionInstallEvent,
  ExtensionDisableEvent,
  ExtensionEnableEvent,
  ExtensionUninstallEvent,
  ExtensionUpdateEvent,
  ModelSlashCommandEvent,
} from './src/telemetry/types.js';
// Note: makeFakeConfig removed from production export - use in tests only
// export { makeFakeConfig } from './src/test-utils/config.js';
export * from './src/utils/pathReader.js';
export { ClearcutLogger } from './src/telemetry/clearcut-logger/clearcut-logger.js';
export { logModelSlashCommand } from './src/telemetry/loggers.js';
export { KeychainTokenStorage } from './src/mcp/token-storage/keychain-token-storage.js';
export * from './src/utils/googleQuotaErrors.js';
export type { GoogleApiError } from './src/utils/googleErrors.js';
export { getCodeAssistServer } from './src/code_assist/codeAssist.js';
export { getExperiments } from './src/code_assist/experiments/experiments.js';
export { ExperimentFlags } from './src/code_assist/experiments/flagNames.js';
export { getErrorStatus, ModelNotFoundError } from './src/utils/httpErrors.js';

// Export policy types (used by CLI)
export { ApprovalMode } from './src/policy/types.js';

// Export extension loader types (used by CLI)
export type { ExtensionEvents } from './src/utils/extensionLoader.js';

// Export chat recording service (used by CLI)
export { ChatRecordingService } from './src/services/chatRecordingService.js';

// Note: createMockMessageBus removed from production export - use in tests only
// export { createMockMessageBus } from './src/test-utils/mock-message-bus.js';
