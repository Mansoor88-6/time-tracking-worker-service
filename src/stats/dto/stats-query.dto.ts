import { IsInt, IsString, IsOptional, Matches } from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * Stats Query DTO
 *
 * Validates query parameters for dashboard stats endpoint.
 */
export class StatsQueryDto {
  @Type(() => Number)
  @IsInt()
  tenantId: number;

  @Type(() => Number)
  @IsInt()
  userId: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be in YYYY-MM-DD format',
  })
  date: string; // YYYY-MM-DD

  @IsString()
  @IsOptional()
  tz?: string; // IANA timezone, e.g., 'Asia/Karachi'
}
