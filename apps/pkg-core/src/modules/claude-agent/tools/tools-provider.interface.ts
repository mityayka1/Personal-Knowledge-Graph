import type { ToolDefinition } from './tool.types';

/**
 * Interface for tool providers that register with ToolsRegistryService.
 *
 * Tool providers implement this interface and call
 * toolsRegistry.registerProvider(category, this) in their onModuleInit().
 */
export interface ToolsProviderInterface {
  getTools(): ToolDefinition[];
  hasTools?(): boolean;
}
