import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpStatus,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsArray, IsOptional } from 'class-validator';
import {
  ExtractionCarouselStateService,
  ExtractionCarouselNavResult,
  ExtractionCarouselItem,
} from './extraction-carousel-state.service';
import {
  ExtractedProject,
  ExtractedTask,
  ExtractedCommitment,
} from './daily-synthesis-extraction.types';
import {
  ExtractionPersistenceService,
  PersistExtractionResult,
} from './extraction-persistence.service';

// ─────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────

class CreateExtractionCarouselDto {
  @ApiProperty({ description: 'Telegram chat ID' })
  @IsString()
  chatId: string;

  @ApiProperty({ description: 'Telegram message ID for edit operations' })
  @IsNumber()
  messageId: number;

  @ApiProperty({ type: [Object], description: 'Extracted projects' })
  @IsArray()
  projects: ExtractedProject[];

  @ApiProperty({ type: [Object], description: 'Extracted tasks' })
  @IsArray()
  tasks: ExtractedTask[];

  @ApiProperty({ type: [Object], description: 'Extracted commitments' })
  @IsArray()
  commitments: ExtractedCommitment[];

  @ApiProperty({ required: false, description: 'Synthesis date (ISO format)' })
  @IsString()
  @IsOptional()
  synthesisDate?: string;

  @ApiProperty({ required: false, description: 'Focus topic if specified' })
  @IsString()
  @IsOptional()
  focusTopic?: string;
}

class PersistExtractionDto {
  @ApiProperty({ description: 'Owner entity ID (user entity)' })
  @IsString()
  ownerEntityId: string;
}

interface ExtractionCarouselNavResponse {
  success: boolean;
  complete: boolean;
  item?: ExtractionCarouselItem;
  message?: string;
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
  chatId?: string;
  messageId?: number;
  index?: number;
  total?: number;
  remaining?: number;
  error?: string;
}

interface ExtractionCarouselStateResponse {
  exists: boolean;
  chatId?: string;
  messageId?: number;
  currentIndex?: number;
  total?: number;
  remaining?: number;
  stats?: {
    processed: number;
    confirmed: number;
    skipped: number;
    confirmedByType: { projects: number; tasks: number; commitments: number };
  };
}

interface CreateCarouselResponse {
  success: boolean;
  carouselId?: string;
  total?: number;
  message?: string;
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────

@ApiTags('extraction-carousel')
@Controller('extraction-carousel')
export class ExtractionCarouselController {
  private readonly logger = new Logger(ExtractionCarouselController.name);

  constructor(
    private readonly carouselService: ExtractionCarouselStateService,
    private readonly persistenceService: ExtractionPersistenceService,
  ) {}

  /**
   * Create a new extraction carousel
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create extraction carousel from extracted items' })
  @ApiBody({ type: CreateExtractionCarouselDto })
  @ApiResponse({ status: 201, description: 'Carousel created' })
  async create(
    @Body() dto: CreateExtractionCarouselDto,
  ): Promise<CreateCarouselResponse> {
    try {
      // Map DTO fields to source-agnostic internal fields
      const carouselId = await this.carouselService.create({
        conversationId: dto.chatId,
        messageRef: String(dto.messageId),
        projects: dto.projects,
        tasks: dto.tasks,
        commitments: dto.commitments,
        synthesisDate: dto.synthesisDate,
        focusTopic: dto.focusTopic,
      });

      const current = await this.carouselService.getCurrentItem(carouselId);

      if (!current) {
        return {
          success: false,
          error: 'Failed to get first item',
        };
      }

      return {
        success: true,
        carouselId,
        total: current.total,
        message: this.formatItemCard(current),
        buttons: this.getCarouselButtons(carouselId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to create carousel: ${message}`);
      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Get carousel state
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get extraction carousel state by ID' })
  @ApiParam({ name: 'id', description: 'Carousel ID (e.g., ec_a1b2c3d4e5f6)' })
  @ApiResponse({ status: 200, description: 'Carousel state' })
  async getState(@Param('id') carouselId: string): Promise<ExtractionCarouselStateResponse> {
    const state = await this.carouselService.get(carouselId);

    if (!state) {
      return { exists: false };
    }

    const stats = await this.carouselService.getStats(carouselId);
    const remaining = state.items.filter(
      (i) => !state.processedIds.includes(i.id),
    ).length;

    return {
      exists: true,
      chatId: state.conversationId,
      messageId: parseInt(state.messageRef, 10),
      currentIndex: state.currentIndex,
      total: state.items.length,
      remaining,
      stats: stats ? {
        processed: stats.processed,
        confirmed: stats.confirmed,
        skipped: stats.skipped,
        confirmedByType: stats.confirmedByType,
      } : undefined,
    };
  }

  /**
   * Get current carousel item
   */
  @Get(':id/current')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get current extraction carousel item' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async getCurrent(@Param('id') carouselId: string): Promise<ExtractionCarouselNavResponse> {
    const state = await this.carouselService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const navResult = await this.carouselService.getCurrentItem(carouselId);

    if (!navResult) {
      const stats = await this.carouselService.getStats(carouselId);
      return {
        success: true,
        complete: true,
        message: this.formatComplete(stats),
        chatId: state.conversationId,
        messageId: parseInt(state.messageRef, 10),
      };
    }

    return this.buildNavResponse(carouselId, navResult, state.conversationId, parseInt(state.messageRef, 10));
  }

  /**
   * Navigate to next item
   */
  @Post(':id/next')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Navigate to next unprocessed item' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async navigateNext(@Param('id') carouselId: string): Promise<ExtractionCarouselNavResponse> {
    const state = await this.carouselService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const navResult = await this.carouselService.next(carouselId);

    if (!navResult) {
      const stats = await this.carouselService.getStats(carouselId);
      return {
        success: true,
        complete: true,
        message: this.formatComplete(stats),
        chatId: state.conversationId,
        messageId: parseInt(state.messageRef, 10),
      };
    }

    return this.buildNavResponse(carouselId, navResult, state.conversationId, parseInt(state.messageRef, 10));
  }

  /**
   * Navigate to previous item
   */
  @Post(':id/prev')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Navigate to previous unprocessed item' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async navigatePrev(@Param('id') carouselId: string): Promise<ExtractionCarouselNavResponse> {
    const state = await this.carouselService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const navResult = await this.carouselService.prev(carouselId);

    if (!navResult) {
      const stats = await this.carouselService.getStats(carouselId);
      return {
        success: true,
        complete: true,
        message: this.formatComplete(stats),
        chatId: state.conversationId,
        messageId: parseInt(state.messageRef, 10),
      };
    }

    return this.buildNavResponse(carouselId, navResult, state.conversationId, parseInt(state.messageRef, 10));
  }

  /**
   * Confirm current item and navigate to next
   */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm current item and navigate to next' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async confirmCurrent(@Param('id') carouselId: string): Promise<ExtractionCarouselNavResponse> {
    const state = await this.carouselService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const current = await this.carouselService.getCurrentItem(carouselId);

    if (!current) {
      const stats = await this.carouselService.getStats(carouselId);
      return {
        success: true,
        complete: true,
        message: this.formatComplete(stats),
        chatId: state.conversationId,
        messageId: parseInt(state.messageRef, 10),
      };
    }

    // Confirm the item
    await this.carouselService.confirm(carouselId, current.item.id);

    this.logger.log(
      `Carousel ${carouselId}: confirmed ${current.item.type} "${this.getItemTitle(current.item)}"`,
    );

    // Get next item
    const next = await this.carouselService.next(carouselId);

    if (!next) {
      const stats = await this.carouselService.getStats(carouselId);
      return {
        success: true,
        complete: true,
        message: this.formatComplete(stats),
        chatId: state.conversationId,
        messageId: parseInt(state.messageRef, 10),
      };
    }

    return this.buildNavResponse(carouselId, next, state.conversationId, parseInt(state.messageRef, 10));
  }

  /**
   * Skip current item and navigate to next
   */
  @Post(':id/skip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Skip current item and navigate to next' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async skipCurrent(@Param('id') carouselId: string): Promise<ExtractionCarouselNavResponse> {
    const state = await this.carouselService.get(carouselId);

    if (!state) {
      return { success: false, complete: false, error: 'Carousel not found or expired' };
    }

    const current = await this.carouselService.getCurrentItem(carouselId);

    if (!current) {
      const stats = await this.carouselService.getStats(carouselId);
      return {
        success: true,
        complete: true,
        message: this.formatComplete(stats),
        chatId: state.conversationId,
        messageId: parseInt(state.messageRef, 10),
      };
    }

    // Skip the item
    await this.carouselService.skip(carouselId, current.item.id);

    this.logger.log(
      `Carousel ${carouselId}: skipped ${current.item.type} "${this.getItemTitle(current.item)}"`,
    );

    // Get next item
    const next = await this.carouselService.next(carouselId);

    if (!next) {
      const stats = await this.carouselService.getStats(carouselId);
      return {
        success: true,
        complete: true,
        message: this.formatComplete(stats),
        chatId: state.conversationId,
        messageId: parseInt(state.messageRef, 10),
      };
    }

    return this.buildNavResponse(carouselId, next, state.conversationId, parseInt(state.messageRef, 10));
  }

  /**
   * Get confirmed items for persistence
   */
  @Get(':id/confirmed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all confirmed items from carousel' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async getConfirmed(@Param('id') carouselId: string): Promise<{
    success: boolean;
    projects?: ExtractedProject[];
    tasks?: ExtractedTask[];
    commitments?: ExtractedCommitment[];
    error?: string;
  }> {
    const confirmed = await this.carouselService.getConfirmedItems(carouselId);

    if (!confirmed) {
      return { success: false, error: 'Carousel not found or expired' };
    }

    return {
      success: true,
      ...confirmed,
    };
  }

  /**
   * Get carousel statistics
   */
  @Get(':id/stats')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get carousel processing statistics' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  async getStats(@Param('id') carouselId: string): Promise<{
    success: boolean;
    stats?: {
      total: number;
      processed: number;
      confirmed: number;
      skipped: number;
      confirmedByType: { projects: number; tasks: number; commitments: number };
    };
    error?: string;
  }> {
    const stats = await this.carouselService.getStats(carouselId);

    if (!stats) {
      return { success: false, error: 'Carousel not found or expired' };
    }

    return { success: true, stats };
  }

  /**
   * Persist confirmed items as database entities
   */
  @Post(':id/persist')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Persist confirmed items as Activity/Commitment entities' })
  @ApiParam({ name: 'id', description: 'Carousel ID' })
  @ApiBody({ type: PersistExtractionDto })
  @ApiResponse({ status: 200, description: 'Persistence result' })
  async persistConfirmed(
    @Param('id') carouselId: string,
    @Body() dto: PersistExtractionDto,
  ): Promise<{
    success: boolean;
    result?: PersistExtractionResult;
    error?: string;
  }> {
    try {
      const state = await this.carouselService.get(carouselId);

      if (!state) {
        return { success: false, error: 'Carousel not found or expired' };
      }

      const confirmed = await this.carouselService.getConfirmedItems(carouselId);

      if (!confirmed) {
        return { success: false, error: 'Failed to get confirmed items' };
      }

      // Check if there's anything to persist
      const totalConfirmed =
        confirmed.projects.length +
        confirmed.tasks.length +
        confirmed.commitments.length;

      if (totalConfirmed === 0) {
        return {
          success: true,
          result: {
            activityIds: [],
            commitmentIds: [],
            projectsCreated: 0,
            tasksCreated: 0,
            commitmentsCreated: 0,
            errors: [],
          },
        };
      }

      // Persist confirmed items
      const result = await this.persistenceService.persist({
        ownerEntityId: dto.ownerEntityId,
        projects: confirmed.projects,
        tasks: confirmed.tasks,
        commitments: confirmed.commitments,
        synthesisDate: state.synthesisDate,
        focusTopic: state.focusTopic,
      });

      this.logger.log(
        `Carousel ${carouselId}: persisted ${result.projectsCreated} projects, ` +
          `${result.tasksCreated} tasks, ${result.commitmentsCreated} commitments ` +
          `(${result.errors.length} errors)`,
      );

      return { success: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to persist carousel ${carouselId}: ${message}`);
      return { success: false, error: message };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────

  private buildNavResponse(
    carouselId: string,
    navResult: ExtractionCarouselNavResult,
    chatId: string,
    messageId: number,
  ): ExtractionCarouselNavResponse {
    return {
      success: true,
      complete: false,
      item: navResult.item,
      message: this.formatItemCard(navResult),
      buttons: this.getCarouselButtons(carouselId),
      chatId,
      messageId,
      index: navResult.index,
      total: navResult.total,
      remaining: navResult.remaining,
    };
  }

  /**
   * Format item card for Telegram display
   */
  private formatItemCard(navResult: ExtractionCarouselNavResult): string {
    const { item, index, total, remaining } = navResult;
    const lines: string[] = [];

    // Header with position
    const typeIcon = this.getTypeIcon(item.type);
    const typeName = this.getTypeName(item.type);
    lines.push(`${typeIcon} <b>${typeName}</b> (${index + 1}/${total})`);
    lines.push('');

    // Item details based on type
    switch (item.type) {
      case 'project':
        this.formatProjectDetails(lines, item.data as ExtractedProject);
        break;
      case 'task':
        this.formatTaskDetails(lines, item.data as ExtractedTask);
        break;
      case 'commitment':
        this.formatCommitmentDetails(lines, item.data as ExtractedCommitment);
        break;
    }

    // Confidence and remaining
    lines.push('');
    const confidence = (item.data as any).confidence ?? 0;
    lines.push(`<i>Уверенность: ${Math.round(confidence * 100)}%</i>`);
    lines.push(`<i>Осталось: ${remaining - 1}</i>`);

    return lines.join('\n');
  }

  private formatProjectDetails(lines: string[], project: ExtractedProject): void {
    lines.push(`<b>${project.name}</b>`);

    if (project.isNew) {
      lines.push('🆕 Новый проект');
    } else if (project.existingActivityId) {
      lines.push('📁 Существующий проект');
    }

    if (project.participants?.length > 0) {
      lines.push(`👥 ${project.participants.join(', ')}`);
    }

    if (project.client) {
      lines.push(`🏢 Клиент: ${project.client}`);
    }

    if (project.status) {
      lines.push(`📊 Статус: ${project.status}`);
    }

    if (project.sourceQuote) {
      lines.push('');
      lines.push(`<i>"${this.truncate(project.sourceQuote, 100)}"</i>`);
    }
  }

  private formatTaskDetails(lines: string[], task: ExtractedTask): void {
    const statusIcon = task.status === 'done' ? '✅' :
                      task.status === 'in_progress' ? '🔄' : '⏳';

    lines.push(`${statusIcon} <b>${task.title}</b>`);

    if (task.projectName) {
      lines.push(`📁 Проект: ${task.projectName}`);
    }

    if (task.assignee) {
      lines.push(`👤 Ответственный: ${task.assignee}`);
    }

    if (task.deadline) {
      lines.push(`📅 Дедлайн: ${task.deadline}`);
    }

    if (task.priority) {
      const priorityIcon = task.priority === 'high' ? '🔴' :
                          task.priority === 'medium' ? '🟡' : '🟢';
      lines.push(`${priorityIcon} Приоритет: ${task.priority}`);
    }
  }

  private formatCommitmentDetails(lines: string[], commitment: ExtractedCommitment): void {
    const typeIcon = commitment.type === 'promise' ? '🎯' :
                    commitment.type === 'request' ? '📨' :
                    commitment.type === 'agreement' ? '🤝' :
                    commitment.type === 'deadline' ? '⏰' : '🔔';

    lines.push(`${typeIcon} <b>${commitment.what}</b>`);
    lines.push(`👤 ${commitment.from} → ${commitment.to}`);

    if (commitment.deadline) {
      lines.push(`📅 До: ${commitment.deadline}`);
    }

    if (commitment.priority) {
      const priorityIcon = commitment.priority === 'high' ? '🔴' :
                          commitment.priority === 'medium' ? '🟡' : '🟢';
      lines.push(`${priorityIcon} Приоритет: ${commitment.priority}`);
    }
  }

  /**
   * Format completion message
   */
  private formatComplete(stats: {
    total: number;
    confirmed: number;
    skipped: number;
    confirmedByType: { projects: number; tasks: number; commitments: number };
  } | null): string {
    if (!stats) {
      return '✅ Обработка завершена';
    }

    const lines: string[] = [];
    lines.push('✅ <b>Обработка завершена!</b>');
    lines.push('');

    if (stats.confirmed > 0) {
      lines.push(`📊 Подтверждено: ${stats.confirmed} из ${stats.total}`);

      const parts: string[] = [];
      if (stats.confirmedByType.projects > 0) {
        parts.push(`${stats.confirmedByType.projects} проект(ов)`);
      }
      if (stats.confirmedByType.tasks > 0) {
        parts.push(`${stats.confirmedByType.tasks} задач(и)`);
      }
      if (stats.confirmedByType.commitments > 0) {
        parts.push(`${stats.confirmedByType.commitments} обязательств(а)`);
      }

      if (parts.length > 0) {
        lines.push(`   ${parts.join(', ')}`);
      }
    }

    if (stats.skipped > 0) {
      lines.push(`⏭️ Пропущено: ${stats.skipped}`);
    }

    return lines.join('\n');
  }

  /**
   * Get carousel navigation buttons
   */
  private getCarouselButtons(carouselId: string): Array<Array<{ text: string; callback_data: string }>> {
    return [
      // Navigation row
      [
        { text: '◀️', callback_data: `exc_prev:${carouselId}` },
        { text: '▶️', callback_data: `exc_next:${carouselId}` },
      ],
      // Action row
      [
        { text: '✅ Подтвердить', callback_data: `exc_confirm:${carouselId}` },
        { text: '⏭️ Пропустить', callback_data: `exc_skip:${carouselId}` },
      ],
    ];
  }

  private getTypeIcon(type: string): string {
    switch (type) {
      case 'project': return '📁';
      case 'task': return '📋';
      case 'commitment': return '🤝';
      default: return '📌';
    }
  }

  private getTypeName(type: string): string {
    switch (type) {
      case 'project': return 'Проект';
      case 'task': return 'Задача';
      case 'commitment': return 'Обязательство';
      default: return 'Элемент';
    }
  }

  private getItemTitle(item: ExtractionCarouselItem): string {
    switch (item.type) {
      case 'project':
        return (item.data as ExtractedProject).name;
      case 'task':
        return (item.data as ExtractedTask).title;
      case 'commitment':
        return (item.data as ExtractedCommitment).what;
      default:
        return 'Unknown';
    }
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }
}
