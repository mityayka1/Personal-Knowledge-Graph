import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength, MaxLength } from 'class-validator';
import { ApprovalService, PendingApproval } from './approval.service';
import { TelegramSendService, SendResult } from './telegram-send.service';

/**
 * DTO for approval action
 */
class ApprovalActionDto {
  @ApiProperty({
    description: 'Action to take',
    enum: ['approve', 'reject', 'edit'],
  })
  @IsIn(['approve', 'reject', 'edit'])
  action: 'approve' | 'reject' | 'edit';
}

/**
 * DTO for setting edit mode
 */
class EditModeDto {
  @ApiProperty({
    description: 'Edit mode',
    enum: ['describe', 'verbatim'],
  })
  @IsIn(['describe', 'verbatim'])
  mode: 'describe' | 'verbatim';
}

/**
 * DTO for updating text
 */
class UpdateTextDto {
  @ApiProperty({
    description: 'New message text',
    minLength: 1,
    maxLength: 4096,
  })
  @IsString()
  @MinLength(1, { message: 'Text cannot be empty' })
  @MaxLength(4096, { message: 'Text cannot exceed 4096 characters' })
  text: string;
}

/**
 * DTO for regenerating message
 */
class RegenerateDto {
  @ApiProperty({
    description: 'Description for AI to regenerate message',
    minLength: 5,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(5, { message: 'Description must be at least 5 characters' })
  @MaxLength(1000, { message: 'Description cannot exceed 1000 characters' })
  description: string;
}

/**
 * Response for approval endpoints
 */
interface ApprovalResponse {
  success: boolean;
  approval?: Partial<PendingApproval>;
  error?: string;
}

/**
 * Controller for message approval flow.
 *
 * Endpoints are called by telegram-adapter when user clicks
 * approval buttons in bot messages.
 *
 * Flow:
 * 1. User sees approval message in bot
 * 2. User clicks button (approve/edit/cancel)
 * 3. telegram-adapter calls this controller
 * 4. Controller updates approval state
 * 5. If approved, sends message via TelegramSendService
 */
@ApiTags('approvals')
@Controller('approvals')
export class ApprovalController {
  private readonly logger = new Logger(ApprovalController.name);

  constructor(
    private readonly approvalService: ApprovalService,
    private readonly telegramSendService: TelegramSendService,
  ) {}

  /**
   * Get approval by ID
   */
  @Get(':approvalId')
  @ApiOperation({ summary: 'Get pending approval' })
  @ApiParam({ name: 'approvalId', description: 'Approval ID (e.g., a_abc123)' })
  @ApiResponse({ status: 200, description: 'Approval found' })
  @ApiResponse({ status: 404, description: 'Approval not found or expired' })
  async getApproval(
    @Param('approvalId') approvalId: string,
  ): Promise<ApprovalResponse> {
    const approval = await this.approvalService.get(approvalId);

    if (!approval) {
      throw new NotFoundException('Approval not found or expired');
    }

    return {
      success: true,
      approval: {
        id: approval.id,
        entityId: approval.entityId,
        entityName: approval.entityName,
        text: approval.text,
        status: approval.status,
        editMode: approval.editMode,
      },
    };
  }

  /**
   * Approve and send message
   */
  @Post(':approvalId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve and send message' })
  @ApiParam({ name: 'approvalId', description: 'Approval ID' })
  @ApiResponse({ status: 200, description: 'Message sent' })
  @ApiResponse({ status: 404, description: 'Approval not found' })
  async approve(
    @Param('approvalId') approvalId: string,
  ): Promise<{ success: boolean; sendResult?: SendResult; error?: string }> {
    const approval = await this.approvalService.handleAction(
      approvalId,
      'approve',
    );

    if (!approval) {
      throw new NotFoundException('Approval not found or expired');
    }

    // Send message via userbot
    const sendResult = await this.telegramSendService.sendToChat(
      approval.telegramUserId,
      approval.text,
    );

    if (!sendResult.success) {
      this.logger.error(
        `Failed to send message for approval ${approvalId}: ${sendResult.error}`,
      );
      return {
        success: false,
        error: sendResult.error,
      };
    }

    this.logger.log(
      `Sent message for approval ${approvalId} to ${approval.entityName}`,
    );

    return {
      success: true,
      sendResult,
    };
  }

  /**
   * Reject (cancel) approval
   */
  @Post(':approvalId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject/cancel approval' })
  @ApiParam({ name: 'approvalId', description: 'Approval ID' })
  @ApiResponse({ status: 200, description: 'Approval rejected' })
  @ApiResponse({ status: 404, description: 'Approval not found' })
  async reject(
    @Param('approvalId') approvalId: string,
  ): Promise<ApprovalResponse> {
    const approval = await this.approvalService.handleAction(
      approvalId,
      'reject',
    );

    if (!approval) {
      throw new NotFoundException('Approval not found or expired');
    }

    return {
      success: true,
      approval: {
        id: approval.id,
        status: approval.status,
      },
    };
  }

  /**
   * Enter edit mode
   */
  @Post(':approvalId/edit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enter edit mode' })
  @ApiParam({ name: 'approvalId', description: 'Approval ID' })
  @ApiResponse({ status: 200, description: 'Edit mode entered' })
  @ApiResponse({ status: 404, description: 'Approval not found' })
  async edit(
    @Param('approvalId') approvalId: string,
  ): Promise<ApprovalResponse> {
    const approval = await this.approvalService.handleAction(
      approvalId,
      'edit',
    );

    if (!approval) {
      throw new NotFoundException('Approval not found or expired');
    }

    return {
      success: true,
      approval: {
        id: approval.id,
        status: approval.status,
        text: approval.text,
        entityName: approval.entityName,
      },
    };
  }

  /**
   * Set edit mode (describe or verbatim)
   */
  @Post(':approvalId/edit-mode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set edit mode' })
  @ApiParam({ name: 'approvalId', description: 'Approval ID' })
  @ApiResponse({ status: 200, description: 'Edit mode set' })
  @ApiResponse({ status: 404, description: 'Approval not found' })
  async setEditMode(
    @Param('approvalId') approvalId: string,
    @Body() dto: EditModeDto,
  ): Promise<ApprovalResponse> {
    const approval = await this.approvalService.setEditMode(
      approvalId,
      dto.mode,
    );

    if (!approval) {
      throw new NotFoundException('Approval not found or expired');
    }

    return {
      success: true,
      approval: {
        id: approval.id,
        status: approval.status,
        editMode: approval.editMode,
      },
    };
  }

  /**
   * Update message text (after verbatim edit)
   */
  @Post(':approvalId/update-text')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update message text' })
  @ApiParam({ name: 'approvalId', description: 'Approval ID' })
  @ApiResponse({ status: 200, description: 'Text updated' })
  @ApiResponse({ status: 404, description: 'Approval not found' })
  async updateText(
    @Param('approvalId') approvalId: string,
    @Body() dto: UpdateTextDto,
  ): Promise<ApprovalResponse> {
    const approval = await this.approvalService.updateText(
      approvalId,
      dto.text,
    );

    if (!approval) {
      throw new NotFoundException('Approval not found or expired');
    }

    return {
      success: true,
      approval: {
        id: approval.id,
        status: approval.status,
        text: approval.text,
      },
    };
  }

  /**
   * Regenerate message based on description
   */
  @Post(':approvalId/regenerate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerate message from description' })
  @ApiParam({ name: 'approvalId', description: 'Approval ID' })
  @ApiResponse({ status: 200, description: 'Message regenerated' })
  @ApiResponse({ status: 404, description: 'Approval not found' })
  async regenerate(
    @Param('approvalId') approvalId: string,
    @Body() dto: RegenerateDto,
  ): Promise<ApprovalResponse> {
    // Get current approval
    const approval = await this.approvalService.get(approvalId);
    if (!approval) {
      throw new NotFoundException('Approval not found or expired');
    }

    // TODO: Call Claude to regenerate message based on description
    // For now, just update with the description as placeholder
    const newText = `${dto.description}`;

    const updated = await this.approvalService.updateText(approvalId, newText);

    return {
      success: true,
      approval: {
        id: updated?.id,
        status: updated?.status,
        text: updated?.text,
      },
    };
  }
}
