/**
 * `jose` ships as ESM only, which ts-jest's CommonJS transform cannot load.
 * Nothing under test signs or verifies a JWT — the token service is stubbed
 * wholesale in these specs — so it is mapped to this stub rather than
 * reconfiguring the whole suite for ESM. If a spec ever does need real JWT
 * behaviour, that is the moment to switch the runner, not to fill this in.
 */
export const calculateJwkThumbprint = () => {
  throw new Error('jose is stubbed in tests');
};
export const exportJWK = calculateJwkThumbprint;
export const importSPKI = calculateJwkThumbprint;
export const importPKCS8 = calculateJwkThumbprint;
export const SignJWT = class {};
export const jwtVerify = calculateJwkThumbprint;
export const createLocalJWKSet = calculateJwkThumbprint;
