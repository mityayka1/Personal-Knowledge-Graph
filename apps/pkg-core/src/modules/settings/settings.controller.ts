import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  Query,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import { UpdateSettingDto } from './dto/update-setting.dto';

@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @Get()
  async findAll(@Query('category') category?: string) {
    if (category) {
      return this.settingsService.findByCategory(category);
    }
    return this.settingsService.findAll();
  }

  @Get(':key')
  async findOne(@Param('key') key: string) {
    const setting = await this.settingsService.findOne(key);
    if (!setting) {
      throw new NotFoundException(`Setting ${key} not found`);
    }
    return setting;
  }

  @Put(':key')
  async update(@Param('key') key: string, @Body() dto: UpdateSettingDto) {
    // Validate session.gapThresholdMinutes (15-1440 minutes)
    if (key === 'session.gapThresholdMinutes') {
      const value = Number(dto.value);
      if (isNaN(value) || value < 15 || value > 1440) {
        throw new BadRequestException(
          'Порог сессии должен быть числом от 15 до 1440 минут (от 15 минут до 24 часов)',
        );
      }
    }

    return this.settingsService.update(key, dto.value, dto.description);
  }

  // Convenience endpoint for extraction settings
  @Get('extraction/all')
  async getExtractionSettings() {
    return this.settingsService.getExtractionSettings();
  }
}
