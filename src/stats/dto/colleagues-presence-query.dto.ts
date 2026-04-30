import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min, Max } from 'class-validator';

/** Internal worker: recent activity per user for colleague presence. */
export class ColleaguesPresenceQueryDto {
  @Type(() => Number)
  @IsInt()
  tenantId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(600)
  windowSec?: number;
}
