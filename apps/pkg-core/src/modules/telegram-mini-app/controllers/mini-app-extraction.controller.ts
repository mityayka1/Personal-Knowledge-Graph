import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { TelegramAuthGuard, TelegramUser } from '../guards/telegram-auth.guard';
import { TgUser } from '../decorators/telegram-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { ExtractionCarouselStateService } from '../../extraction/extraction-carousel-state.service';
import { ConfirmExtractionDto, SkipExtractionDto } from '../dto/mini-app.dto';
import { MiniAppMapperService } from '../services/mini-app-mapper.service';

/**
 * Mini App Extraction Carousel Controller.
 * Handles: /extraction/:carouselId, confirm, skip
 */
@Controller('mini-app')
@Public()
@UseGuards(TelegramAuthGuard)
export class MiniAppExtractionController {
  private readonly logger = new Logger(MiniAppExtractionController.name);

  constructor(
    private readonly extractionCarouselService: ExtractionCarouselStateService,
    private readonly mapper: MiniAppMapperService,
  ) {}

  /**
   * GET /api/mini-app/extraction/:carouselId
   * Returns carousel state with all items.
   */
  @Get('extraction/:carouselId')
  async getExtraction(
    @Param('carouselId') carouselId: string,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`getExtraction ${carouselId} for user ${user?.id}`);

    const state = await this.extractionCarouselService.get(carouselId);
    if (!state) {
      throw new NotFoundException('Extraction carousel not found or expired');
    }

    return this.mapper.mapCarouselStateToResponse(state, carouselId);
  }

  /**
   * POST /api/mini-app/extraction/:carouselId/confirm/:itemId
   * Confirm an extracted item, optionally with edits.
   */
  @Post('extraction/:carouselId/confirm/:itemId')
  async confirmExtraction(
    @Param('carouselId') carouselId: string,
    @Param('itemId') itemId: string,
    @Body() dto: ConfirmExtractionDto,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`confirmExtraction ${carouselId}/${itemId} for user ${user?.id}`);

    const state = await this.extractionCarouselService.get(carouselId);
    if (!state) {
      throw new NotFoundException('Carousel not found or expired');
    }

    await this.extractionCarouselService.confirm(carouselId, itemId);
    const nextItem = await this.extractionCarouselService.getCurrentItem(carouselId);

    return {
      success: true,
      nextIndex: nextItem?.index,
      remaining: nextItem?.remaining ?? 0,
    };
  }

  /**
   * POST /api/mini-app/extraction/:carouselId/skip/:itemId
   * Skip an extracted item.
   */
  @Post('extraction/:carouselId/skip/:itemId')
  async skipExtraction(
    @Param('carouselId') carouselId: string,
    @Param('itemId') itemId: string,
    @Body() dto: SkipExtractionDto,
    @TgUser() user: TelegramUser,
  ) {
    this.logger.debug(`skipExtraction ${carouselId}/${itemId} for user ${user?.id}`);

    const state = await this.extractionCarouselService.get(carouselId);
    if (!state) {
      throw new NotFoundException('Carousel not found or expired');
    }

    await this.extractionCarouselService.skip(carouselId, itemId);
    const nextItem = await this.extractionCarouselService.getCurrentItem(carouselId);

    return {
      success: true,
      nextIndex: nextItem?.index,
      remaining: nextItem?.remaining ?? 0,
    };
  }
}
