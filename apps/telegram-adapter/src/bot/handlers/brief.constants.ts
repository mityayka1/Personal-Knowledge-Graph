/**
 * Brief callback action prefixes for Telegram inline keyboards.
 * Format: {prefix}:{briefId}:{index?}
 *
 * NOTE: This file is duplicated from pkg-core/src/modules/notification/brief.constants.ts
 * to avoid cross-package dependencies. Keep in sync!
 */
export const BRIEF_CALLBACKS = {
  /** Expand item details */
  EXPAND: 'br_e',
  /** Collapse all items */
  COLLAPSE: 'br_c',
  /** Mark item as done */
  DONE: 'br_d',
  /** Mark item as dismissed */
  DISMISS: 'br_x',
  /** Trigger write action */
  WRITE: 'br_w',
  /** Trigger remind action */
  REMIND: 'br_r',
  /** Trigger prepare action */
  PREPARE: 'br_p',
} as const;

export type BriefCallbackAction =
  (typeof BRIEF_CALLBACKS)[keyof typeof BRIEF_CALLBACKS];

/** Actions that require an index parameter */
export const INDEX_REQUIRED_ACTIONS: BriefCallbackAction[] = [
  BRIEF_CALLBACKS.EXPAND,
  BRIEF_CALLBACKS.DONE,
  BRIEF_CALLBACKS.DISMISS,
  BRIEF_CALLBACKS.WRITE,
  BRIEF_CALLBACKS.REMIND,
  BRIEF_CALLBACKS.PREPARE,
];

/**
 * Creates callback data string for brief actions.
 */
export function makeBriefCallback(
  action: BriefCallbackAction,
  briefId: string,
  index?: number,
): string {
  if (index !== undefined) {
    return `${action}:${briefId}:${index}`;
  }
  return `${action}:${briefId}`;
}

/**
 * Parsed brief callback data.
 */
export interface ParsedBriefCallback {
  action: BriefCallbackAction;
  briefId: string;
  index: number | undefined;
}

/**
 * Parses callback data string into components.
 * Returns null if the data is not a valid brief callback.
 */
export function parseBriefCallback(data: string): ParsedBriefCallback | null {
  const parts = data.split(':');
  if (parts.length < 2) return null;

  const [actionStr, briefId, indexStr] = parts;

  // Validate action
  if (!isBriefCallbackAction(actionStr)) {
    return null;
  }

  // Validate briefId
  if (!briefId || briefId.trim() === '') {
    return null;
  }

  // Parse index if present
  let index: number | undefined;
  if (indexStr !== undefined) {
    index = parseInt(indexStr, 10);
    if (isNaN(index) || index < 0) {
      return null; // Invalid index
    }
  }

  return { action: actionStr, briefId, index };
}

/**
 * Type guard to check if a string is a valid BriefCallbackAction.
 */
export function isBriefCallbackAction(
  action: string,
): action is BriefCallbackAction {
  return Object.values(BRIEF_CALLBACKS).includes(action as BriefCallbackAction);
}

/**
 * Checks if callback data is a brief callback.
 */
export function isBriefCallback(data: string): boolean {
  return Object.values(BRIEF_CALLBACKS).some((prefix) =>
    data.startsWith(`${prefix}:`),
  );
}

/**
 * Checks if the given action requires an index parameter.
 */
export function actionRequiresIndex(action: BriefCallbackAction): boolean {
  return INDEX_REQUIRED_ACTIONS.includes(action);
}
