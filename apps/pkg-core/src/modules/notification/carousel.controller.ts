import { Controller, Get, Post, Param, HttpStatus, HttpCode, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CarouselStateService, CarouselNavResult } from './carousel-state.service';
import { NotificationService } from './notification.service';
import { ExtractedEventStatus } from '@pkg/entities';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractedEvent } from '@pkg/entities';
import { Repository } from 'typeorm';

/**
 * Response for carousel navigation operations
 */
export interface CarouselNavResponse {
  success: boolean;
  /** Whether carousel is complete (all events processed) */
  complete: boolean;
  /** Formatted HTML message for editMessageText */
  message?: string;
  /** Buttons for the carousel card */
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
  /** Telegram chat ID for editMessageText */
  chatId?: string;
  /** Telegram message ID for editMessageText */
  messageId?: number;
  /** Number of processed events */
  processedCount?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Response for carousel state
 */
export interface CarouselStateResponse {
  exists: boolean;
  chatId?: string;
  messageId?: number;
  currentIndex?: number;
  total?: number;
  remaining?: number;
}

@ApiTags('carousel')
@Controller('carousel')
export class CarouselController {
  private readonly logger = new Logger(CarouselController.name);

  constructor(
    private readonly carouselStateService: CarouselStateService,
    private readonly notificationService: NotificationService,
    @InjectRepository(ExtractedEvent)
    private readonly extractedEventRepo: Repository<ExtractedEvent>,
  ) {}

  /**
   * Get carousel state
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get carousel state by ID' })
  @ApiParam({ name: 'id', description: 'Carousel ID (e.g., c_a1b2c3d4e5f6)' })
  @ApiResponse({ status: 200, description: 'Carousel state' })
  async getState(@Param('id') carouselId: string): Promise<CarouselStateResponse> {
    const state = await this.carouselStateService.get(carouselId);

    if (!state) {
      return { exists: false };
    }

    const remaining = state.eventIds.filter(
      (id) => !state.processedIds.includes(id),
    ).length;

    return {
      exists: true,
      chatId: state.chatId,
      messageId: state.messageId,
      currentIndex: state.currentIndex,
      total: state.eventIds.length,
      remaining,
    };
  }

  /**
   * Get current carousel event (for display)
   */
  @Get(':id/current')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get current carousel event card' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async getCurrent(@Param('id') carouselId: string): Promise<CarouselNavResponse> {
    const state = await this.carouselStateService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const navResult = await this.carouselStateService.getCurrentEvent(carouselId);

    if (!navResult) {
      // All events processed
      return {
        success: true,
        complete: true,
        message: this.notificationService.formatCarouselComplete(state.processedIds.length),
        chatId: state.chatId,
        messageId: state.messageId,
        processedCount: state.processedIds.length,
      };
    }

    return this.buildNavResponse(carouselId, navResult, state.chatId, state.messageId);
  }

  /**
   * Navigate to next event
   */
  @Post(':id/next')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Navigate to next unprocessed event' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async navigateNext(@Param('id') carouselId: string): Promise<CarouselNavResponse> {
    const state = await this.carouselStateService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const navResult = await this.carouselStateService.next(carouselId);

    if (!navResult) {
      // Wrapped around and no unprocessed events left
      return {
        success: true,
        complete: true,
        message: this.notificationService.formatCarouselComplete(state.processedIds.length),
        chatId: state.chatId,
        messageId: state.messageId,
        processedCount: state.processedIds.length,
      };
    }

    return this.buildNavResponse(carouselId, navResult, state.chatId, state.messageId);
  }

  /**
   * Navigate to previous event
   */
  @Post(':id/prev')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Navigate to previous unprocessed event' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async navigatePrev(@Param('id') carouselId: string): Promise<CarouselNavResponse> {
    const state = await this.carouselStateService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const navResult = await this.carouselStateService.prev(carouselId);

    if (!navResult) {
      // Wrapped around and no unprocessed events left
      return {
        success: true,
        complete: true,
        message: this.notificationService.formatCarouselComplete(state.processedIds.length),
        chatId: state.chatId,
        messageId: state.messageId,
        processedCount: state.processedIds.length,
      };
    }

    return this.buildNavResponse(carouselId, navResult, state.chatId, state.messageId);
  }

  /**
   * Confirm current event and navigate to next
   */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm current event and navigate to next' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async confirmCurrent(@Param('id') carouselId: string): Promise<CarouselNavResponse> {
    const state = await this.carouselStateService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    // Get current event
    const current = await this.carouselStateService.getCurrentEvent(carouselId);

    if (!current) {
      return {
        success: true,
        complete: true,
        message: this.notificationService.formatCarouselComplete(state.processedIds.length),
        chatId: state.chatId,
        messageId: state.messageId,
        processedCount: state.processedIds.length,
      };
    }

    // Confirm the event
    await this.extractedEventRepo.update(current.event.id, {
      status: ExtractedEventStatus.CONFIRMED,
      userResponseAt: new Date(),
    });

    this.logger.log(`Carousel ${carouselId}: confirmed event ${current.event.id}`);

    // Mark as processed
    await this.carouselStateService.markProcessed(carouselId, current.event.id);

    // Get next event
    const next = await this.carouselStateService.next(carouselId);

    // Refresh state for counts
    const updatedState = await this.carouselStateService.get(carouselId);

    if (!next) {
      // All done
      return {
        success: true,
        complete: true,
        message: this.notificationService.formatCarouselComplete(updatedState?.processedIds.length ?? 1),
        chatId: state.chatId,
        messageId: state.messageId,
        processedCount: updatedState?.processedIds.length ?? 1,
      };
    }

    return this.buildNavResponse(carouselId, next, state.chatId, state.messageId);
  }

  /**
   * Reject current event and navigate to next
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject current event and navigate to next' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async rejectCurrent(@Param('id') carouselId: string): Promise<CarouselNavResponse> {
    const state = await this.carouselStateService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    // Get current event
    const current = await this.carouselStateService.getCurrentEvent(carouselId);

    if (!current) {
      return {
        success: true,
        complete: true,
        message: this.notificationService.formatCarouselComplete(state.processedIds.length),
        chatId: state.chatId,
        messageId: state.messageId,
        processedCount: state.processedIds.length,
      };
    }

    // Reject the event
    await this.extractedEventRepo.update(current.event.id, {
      status: ExtractedEventStatus.REJECTED,
      userResponseAt: new Date(),
    });

    this.logger.log(`Carousel ${carouselId}: rejected event ${current.event.id}`);

    // Mark as processed
    await this.carouselStateService.markProcessed(carouselId, current.event.id);

    // Get next event
    const next = await this.carouselStateService.next(carouselId);

    // Refresh state for counts
    const updatedState = await this.carouselStateService.get(carouselId);

    if (!next) {
      // All done
      return {
        success: true,
        complete: true,
        message: this.notificationService.formatCarouselComplete(updatedState?.processedIds.length ?? 1),
        chatId: state.chatId,
        messageId: state.messageId,
        processedCount: updatedState?.processedIds.length ?? 1,
      };
    }

    return this.buildNavResponse(carouselId, next, state.chatId, state.messageId);
  }

  /**
   * Build response for navigation result
   */
  private async buildNavResponse(
    carouselId: string,
    navResult: CarouselNavResult,
    chatId: string,
    messageId: number,
  ): Promise<CarouselNavResponse> {
    const message = await this.notificationService.formatCarouselCard(navResult);
    const buttons = this.notificationService.getCarouselButtons(carouselId);

    return {
      success: true,
      complete: false,
      message,
      buttons,
      chatId,
      messageId,
    };
  }
}
