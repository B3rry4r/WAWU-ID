/**
 * The host every mailed link to a WAWU page starts with (task ID-LINKS,
 * R-133 point 4). FRONTEND_URL, then APP_URL, then the live site, with
 * trailing slashes trimmed, so a link never comes out with no host. An empty
 * setting counts as unset.
 */
export const DEFAULT_APP_URL = 'https://wawuafrica.com';

interface SettingReader {
  get(key: string): string | undefined;
}

export function appBaseUrl(config: SettingReader): string {
  const set = (key: string): string | undefined => {
    const v = config.get(key);
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  return (set('FRONTEND_URL') ?? set('APP_URL') ?? DEFAULT_APP_URL).replace(
    /\/+$/,
    '',
  );
}

/** Where "this was not me" goes: SECURITY_URL when set, else the forgot-password page. */
export function securityUrl(config: SettingReader): string {
  const v = config.get('SECURITY_URL');
  return typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : `${appBaseUrl(config)}/forgot-password`;
}
