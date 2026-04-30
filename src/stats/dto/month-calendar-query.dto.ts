import { IsInt, IsString, IsOptional, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query params for per-day stats over a calendar range (internal worker API).
 */
export class MonthCalendarQueryDto {
  @Type(() => Number)
  @IsInt()
  tenantId: number;

  @Type(() => Number)
  @IsInt()
  userId: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate must be in YYYY-MM-DD format',
  })
  startDate: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'endDate must be in YYYY-MM-DD format',
  })
  endDate: string;

  @IsString()
  @IsOptional()
  tz?: string;
}
