import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { SignupChannelService } from './signup-channel.service';
import { SignupSequenceController } from './signup-sequence.controller';

/**
 * AUTH-07 round 3 (the verifier's F-D): A3 words its line by the channel the
 * sign-up code will travel, so it has to be able to ask before anyone types
 * anything. `GET /auth/signup/channel` says what `SIGNUP_VERIFY_CHANNEL` is.
 */
describe('GET /auth/signup/channel (which way the sign-up code will travel)', () => {
  const route = (env: Record<string, string | undefined>) => {
    const channel = new SignupChannelService(
      { get: (name: string) => env[name] } as never,
      {} as never,
      {} as never,
    );
    return new SignupSequenceController(channel, {} as never, {} as never);
  };

  it('says phone when the setting is unset: the sign-up that runs today', () => {
    expect(route({}).channel()).toEqual({ data: { channel: 'phone' } });
  });

  it('says phone for phone, for the round 1 name sms, and for anything that is not a literal email', () => {
    for (const value of ['phone', 'sms', 'emails', '', 'true']) {
      expect(route({ SIGNUP_VERIFY_CHANNEL: value }).channel()).toEqual({
        data: { channel: 'phone' },
      });
    }
  });

  it('says email when the setting is email, in any case', () => {
    for (const value of ['email', ' EMAIL ', 'Email']) {
      expect(route({ SIGNUP_VERIFY_CHANNEL: value }).channel()).toEqual({
        data: { channel: 'email' },
      });
    }
  });

  it('is a plain GET of auth/signup/channel that asks for no sign-in', () => {
    const handler: object = Reflect.get(
      SignupSequenceController.prototype,
      'channel',
    );
    expect(Reflect.getMetadata(PATH_METADATA, SignupSequenceController)).toBe(
      'auth/signup',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('channel');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SignupSequenceController),
    ).toBeUndefined();
  });
});
