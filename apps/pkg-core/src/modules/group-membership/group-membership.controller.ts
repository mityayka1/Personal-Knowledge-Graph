import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { GroupMembershipService } from './group-membership.service';

/** API DTO with snake_case (matches Telegram Adapter) */
interface MembershipChangeApiDto {
  telegram_chat_id: string;
  telegram_user_id: string;
  display_name?: string;
  action: 'joined' | 'left';
  timestamp: string;
}

@Controller('group-memberships')
export class GroupMembershipController {
  constructor(private readonly membershipService: GroupMembershipService) {}

  @Post('change')
  async handleMembershipChange(@Body() dto: MembershipChangeApiDto) {
    return this.membershipService.handleMembershipChange({
      telegramChatId: dto.telegram_chat_id,
      telegramUserId: dto.telegram_user_id,
      displayName: dto.display_name,
      action: dto.action,
      timestamp: new Date(dto.timestamp),
    });
  }

  @Get('chat/:telegramChatId')
  async getActiveMembers(@Param('telegramChatId') telegramChatId: string) {
    const members = await this.membershipService.getActiveMembers(telegramChatId);
    return {
      telegramChatId,
      activeCount: members.length,
      members,
    };
  }

  @Get('user/:telegramUserId')
  async getUserGroups(@Param('telegramUserId') telegramUserId: string) {
    const groups = await this.membershipService.getUserGroups(telegramUserId);
    return {
      telegramUserId,
      groupsCount: groups.length,
      groups,
    };
  }

  @Get('history')
  async getMembershipHistory(
    @Query('telegramChatId') telegramChatId: string,
    @Query('telegramUserId') telegramUserId: string,
  ) {
    const history = await this.membershipService.getMembershipHistory(
      telegramChatId,
      telegramUserId,
    );
    return {
      telegramChatId,
      telegramUserId,
      history,
    };
  }

  @Get('stats')
  async getStats() {
    return this.membershipService.getStats();
  }
}
