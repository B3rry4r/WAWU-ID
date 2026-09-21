import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Body for PATCH /internal/users/:userId/trust-score.
 *
 * Accepts either `trustScore` or `score` (whichever the Hub's internal client
 * supplies). At least one must be present and be an integer in [0, 100]; the
 * controller resolves whichever is provided.
 */
export class UpdateTrustScoreDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  trustScore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  score?: number;
}
