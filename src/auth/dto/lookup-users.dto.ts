import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * POST /internal/users/lookup body.
 *
 * A bulk read rather than N single reads: the caller is rendering a list of
 * creators, and a per-id round trip would put the page's latency at the mercy
 * of how many creators are on it.
 *
 * Capped at 100 because this is an unpaginated read of an identity table —
 * without a ceiling the endpoint is a way to dump every name WAWU holds in
 * one request, service key or not.
 */
export class LookupUsersDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids!: string[];
}
