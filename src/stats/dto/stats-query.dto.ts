import { IsInt, IsString, IsOptional, Matches, ValidateIf } from 'class-validator';
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
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be in YYYY-MM-DD format',
  })
  date?: string; // YYYY-MM-DD, for single date queries

  @IsString()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate must be in YYYY-MM-DD format',
  })
  @ValidateIf((o) => o.endDate !== undefined)
  startDate?: string; // YYYY-MM-DD, for date range queries

  @IsString()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'endDate must be in YYYY-MM-DD format',
  })
  @ValidateIf((o) => o.startDate !== undefined)
  endDate?: string; // YYYY-MM-DD, for date range queries

  @IsString()
  @IsOptional()
  tz?: string; // IANA timezone, e.g., 'Asia/Karachi'
}
