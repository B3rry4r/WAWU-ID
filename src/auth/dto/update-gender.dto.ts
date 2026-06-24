import { IsOptional, IsString } from 'class-validator';

/**
 * Body for PATCH /internal/users/:userId/gender.
 *
 * The hub proxies a user's own profile gender edit here. `gender` is a free
 * string that the service normalizes to the canonical 'male'|'female' (any
 * unrecognised value -> null, which also lets a user clear their gender).
 */
export class UpdateGenderDto {
  @IsOptional()
  @IsString()
  gender?: string | null;
}
