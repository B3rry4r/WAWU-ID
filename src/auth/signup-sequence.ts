/**
 * The mobile sign-up sequence (AUTH-05), as one ordered list the server
 * enforces.
 *
 *   A2  account type   chosen in the app, sent with A3
 *   A3  details        POST /auth/signup (email, phone, password)
 *   A4  phone          POST /auth/phone/verify/confirm (the texted code; the
 *                      first session is issued here)
 *       email          prove the email with a mailed code, or put it off
 *   A11 creator_setup  an earning account ('creator')
 *   A12 interests      a discovering account ('user')
 *   A13 follows        a discovering account, after A12
 *       done
 *
 * Before the phone code there is no session, so `details` and `phone` are
 * answered by POST /auth/signup/resume (with the sign-up's `attempt` secret).
 * From `email` on, GET /auth/signup/progress answers with a session. Each step
 * can only be completed when it is the next one.
 */

/** A step after the phone code: what POST /auth/signup/progress completes. */
export const AFTER_PHONE_STEPS = [
  'email',
  'creator_setup',
  'interests',
  'follows',
] as const;
export type AfterPhoneStep = (typeof AFTER_PHONE_STEPS)[number];

/** Every answer a client can get about where a sign-up stands. */
export const SIGNUP_STEPS = [
  'details',
  'phone',
  ...AFTER_PHONE_STEPS,
  'done',
] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];

/** The stored record of an account in the sequence (`signup_progress`). */
export interface ProgressRecord {
  emailSkippedAt: Date | null;
  creatorSetupAt: Date | null;
  interestsAt: Date | null;
  followsAt: Date | null;
}

/** What the sequence reads from the account itself. */
export interface AccountFacts {
  /** 'creator' earns; anything else (including none) discovers. */
  accountType: string | null;
  email: string | null;
  emailVerified: boolean;
}

/**
 * The steps after the phone code for this account, in order. An account with
 * no account type is a discovering one: A2 is the app's, and `user` is the
 * pick that changes nothing (no wallet, R-6).
 */
export function stepsFor(accountType: string | null): AfterPhoneStep[] {
  return accountType === 'creator'
    ? ['email', 'creator_setup']
    : ['email', 'interests', 'follows'];
}

/** Whether one step after the phone code is done. */
export function isDone(
  step: AfterPhoneStep,
  account: AccountFacts,
  progress: ProgressRecord,
): boolean {
  switch (step) {
    case 'email':
      // Proven, put off, or nothing to prove (no email on the account).
      return (
        !account.email || account.emailVerified || !!progress.emailSkippedAt
      );
    case 'creator_setup':
      return !!progress.creatorSetupAt;
    case 'interests':
      return !!progress.interestsAt;
    case 'follows':
      return !!progress.followsAt;
  }
}

/** The next step for an account in the sequence, or `done`. */
export function nextStep(
  account: AccountFacts,
  progress: ProgressRecord,
): AfterPhoneStep | 'done' {
  return (
    stepsFor(account.accountType).find(
      (step) => !isDone(step, account, progress),
    ) ?? 'done'
  );
}

/** The column a completed step writes. `email` writes the put-off time. */
export const STEP_COLUMN: Record<AfterPhoneStep, keyof ProgressRecord> = {
  email: 'emailSkippedAt',
  creator_setup: 'creatorSetupAt',
  interests: 'interestsAt',
  follows: 'followsAt',
};
