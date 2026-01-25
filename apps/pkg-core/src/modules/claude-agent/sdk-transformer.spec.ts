import {
  SDKUsage,
  SDKAssistantUsage,
  SDKResultFields,
  normalizeUsage,
  normalizeSDKResult,
  accumulateSDKUsage,
  accumulateSDKResultUsage,
} from './sdk-transformer';
import { UsageStats } from './claude-agent.types';

describe('sdk-transformer', () => {
  describe('normalizeUsage', () => {
    it('should transform snake_case to camelCase', () => {
      const sdkUsage: SDKUsage = {
        input_tokens: 100,
        output_tokens: 200,
      };

      const result = normalizeUsage(sdkUsage);

      expect(result).toEqual({
        inputTokens: 100,
        outputTokens: 200,
        totalCostUsd: 0,
      });
    });

    it('should return zeros for null/undefined input', () => {
      expect(normalizeUsage(null)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      });

      expect(normalizeUsage(undefined)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      });
    });

    it('should handle partial SDK usage', () => {
      const sdkUsage: SDKUsage = {
        input_tokens: 50,
        // output_tokens missing
      };

      const result = normalizeUsage(sdkUsage);

      expect(result.inputTokens).toBe(50);
      expect(result.outputTokens).toBe(0);
    });
  });

  describe('normalizeSDKResult', () => {
    it('should transform full result message', () => {
      const sdkResult: SDKResultFields = {
        type: 'result',
        subtype: 'success',
        result: 'test result',
        structured_output: { answer: 'hello' },
        usage: {
          input_tokens: 100,
          output_tokens: 200,
        },
        total_cost_usd: 0.005,
        duration_ms: 1500,
        duration_api_ms: 1200,
        num_turns: 3,
        session_id: 'sess-123',
        is_error: false,
      };

      const result = normalizeSDKResult<{ answer: string }>(sdkResult);

      expect(result).toEqual({
        result: 'test result',
        structuredOutput: { answer: 'hello' },
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          totalCostUsd: 0.005,
        },
        durationMs: 1500,
        durationApiMs: 1200,
        numTurns: 3,
        sessionId: 'sess-123',
        isError: false,
      });
    });

    it('should infer isError from subtype when is_error is missing', () => {
      const successResult: SDKResultFields = {
        type: 'result',
        subtype: 'success',
      };

      const errorResult: SDKResultFields = {
        type: 'result',
        subtype: 'error_max_turns',
      };

      expect(normalizeSDKResult(successResult).isError).toBe(false);
      expect(normalizeSDKResult(errorResult).isError).toBe(true);
    });

    it('should handle minimal result message', () => {
      const sdkResult: SDKResultFields = {
        type: 'result',
        subtype: 'success',
      };

      const result = normalizeSDKResult(sdkResult);

      expect(result.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      });
      expect(result.structuredOutput).toBeUndefined();
      expect(result.isError).toBe(false);
    });
  });

  describe('accumulateSDKUsage', () => {
    it('should accumulate usage into target', () => {
      const target: UsageStats = {
        inputTokens: 50,
        outputTokens: 100,
        totalCostUsd: 0.01,
      };

      const sdkUsage: SDKAssistantUsage = {
        input_tokens: 30,
        output_tokens: 60,
        cost_usd: 0.005,
      };

      accumulateSDKUsage(sdkUsage, target);

      expect(target).toEqual({
        inputTokens: 80,
        outputTokens: 160,
        totalCostUsd: 0.015,
      });
    });

    it('should do nothing for null/undefined', () => {
      const target: UsageStats = {
        inputTokens: 50,
        outputTokens: 100,
        totalCostUsd: 0.01,
      };

      accumulateSDKUsage(null, target);
      accumulateSDKUsage(undefined, target);

      expect(target).toEqual({
        inputTokens: 50,
        outputTokens: 100,
        totalCostUsd: 0.01,
      });
    });

    it('should handle partial SDK usage', () => {
      const target: UsageStats = {
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      };

      const sdkUsage: SDKAssistantUsage = {
        input_tokens: 10,
        // output_tokens and cost_usd missing
      };

      accumulateSDKUsage(sdkUsage, target);

      expect(target.inputTokens).toBe(10);
      expect(target.outputTokens).toBe(0);
      expect(target.totalCostUsd).toBe(0);
    });
  });

  describe('accumulateSDKResultUsage', () => {
    it('should accumulate from result message', () => {
      const target: UsageStats = {
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      };

      const sdkResult: SDKResultFields = {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 200,
        },
        total_cost_usd: 0.01,
      };

      accumulateSDKResultUsage(sdkResult, target);

      expect(target).toEqual({
        inputTokens: 100,
        outputTokens: 200,
        totalCostUsd: 0.01,
      });
    });

    it('should handle result without usage', () => {
      const target: UsageStats = {
        inputTokens: 50,
        outputTokens: 50,
        totalCostUsd: 0.005,
      };

      const sdkResult: SDKResultFields = {
        type: 'result',
        subtype: 'success',
        // no usage field
      };

      accumulateSDKResultUsage(sdkResult, target);

      expect(target).toEqual({
        inputTokens: 50,
        outputTokens: 50,
        totalCostUsd: 0.005,
      });
    });

    it('should accumulate only total_cost_usd if no usage', () => {
      const target: UsageStats = {
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
      };

      const sdkResult: SDKResultFields = {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.02,
      };

      accumulateSDKResultUsage(sdkResult, target);

      expect(target.totalCostUsd).toBe(0.02);
      expect(target.inputTokens).toBe(0);
      expect(target.outputTokens).toBe(0);
    });
  });
});
