import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import {
  ListNotificationsQueryDto, NotificationListDto, PreferencesDto, ReadAllDto, SnoozeDto, UnreadCountDto, UpdatePreferencesDto,
} from './dto/notifications.dto.js';
import { NotificationsService } from './notifications.service.js';

/**
 * The signed-in user's inbox and preferences. Works with personal API tokens too (the editor
 * extension reads it); a token bound to one workspace only sees and changes that workspace's notifications.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOkResponse({ type: NotificationListDto })
  list(@CurrentUser() user: AuthUser, @Query() q: ListNotificationsQueryDto) {
    return this.notifications.list(user.id, user.tokenWorkspaceId ? { ...q, workspaceId: user.tokenWorkspaceId } : q);
  }

  @Get('unread-count')
  @ApiOkResponse({ type: UnreadCountDto })
  unread(@CurrentUser() user: AuthUser, @Query('workspaceId') workspaceId?: string) {
    return this.notifications.unreadCount(user.id, user.tokenWorkspaceId ?? workspaceId);
  }

  @Get('preferences')
  @ApiOkResponse({ type: PreferencesDto })
  preferences(@CurrentUser() user: AuthUser) {
    return this.notifications.preferences(user.id, user.tokenWorkspaceId);
  }

  @Put('preferences')
  @ApiOkResponse({ type: PreferencesDto })
  updatePreferences(@CurrentUser() user: AuthUser, @Body() dto: UpdatePreferencesDto) {
    // Preferences cover every workspace, so a token limited to one may not change them.
    if (user.tokenWorkspaceId) throw new ForbiddenException('This API token only works in its own workspace');
    return this.notifications.updatePreferences(user.id, dto);
  }

  @Post('read-all') @HttpCode(204)
  readAll(@CurrentUser() user: AuthUser, @Body() dto: ReadAllDto) {
    return this.notifications.readAll(user.id, user.tokenWorkspaceId ?? dto.workspaceId);
  }

  @Post(':id/read') @HttpCode(204)
  read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.setRead(user.id, id, true, user.tokenWorkspaceId);
  }

  @Post(':id/unread') @HttpCode(204)
  unreadOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.setRead(user.id, id, false, user.tokenWorkspaceId);
  }

  @Post(':id/snooze') @HttpCode(204)
  snooze(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SnoozeDto) {
    return this.notifications.snooze(user.id, id, dto.until, new Date(), user.tokenWorkspaceId);
  }

  @Delete(':id') @HttpCode(204)
  dismiss(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.dismiss(user.id, id, user.tokenWorkspaceId);
  }
}
