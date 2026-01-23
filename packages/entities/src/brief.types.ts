/**
 * Types for Morning Brief accordion UI.
 * Shared between pkg-core and telegram-adapter.
 */

/** Type of brief item */
export type BriefItemType = 'meeting' | 'task' | 'followup' | 'overdue' | 'birthday';

/** Source type for brief item - determines how to update status */
export type BriefSourceType = 'entity_event' | 'extracted_event' | 'entity_fact' | 'entity';

/** Single item in the brief (accordion section) */
export interface BriefItem {
  /** Type of the item (determines available actions) */
  type: BriefItemType;
  /** Short title shown in collapsed state */
  title: string;
  /** Entity name (person/org) */
  entityName: string;
  /** Source type for routing operations */
  sourceType: BriefSourceType;
  /** Source entity ID (EntityEvent.id, ExtractedEvent.id, etc.) */
  sourceId: string;
  /** Detailed description shown when expanded */
  details: string;
  /** Original message ID for context link */
  sourceMessageId?: string;
  /** Deep link to source message */
  sourceMessageLink?: string;
  /** Entity ID for actions */
  entityId?: string;
}

/** Brief state stored in Redis */
export interface BriefState {
  /** Unique brief ID */
  id: string;
  /** Telegram chat ID */
  chatId: string;
  /** Telegram message ID for editMessage */
  messageId: number;
  /** All items in the brief */
  items: BriefItem[];
  /** Currently expanded item index (null = all collapsed) */
  expandedIndex: number | null;
  /** Creation timestamp */
  createdAt: number;
}

/** Single button in Telegram inline keyboard */
export interface TelegramKeyboardButton {
  text: string;
  callback_data: string;
}

/** Telegram inline keyboard layout (rows of buttons) */
export type TelegramInlineKeyboard = TelegramKeyboardButton[][];

/** Response from brief API endpoints */
export interface BriefResponse {
  success: boolean;
  state?: BriefState;
  error?: string;
  message?: string;
}
