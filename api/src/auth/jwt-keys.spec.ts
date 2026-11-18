import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import { JwtKeyRing, keyId, previousSecrets } from './jwt-keys.js';

const jwt = new JwtService({});
const OLD = 'o'.repeat(40);
const NEW = 'n'.repeat(40);

describe('JwtKeyRing', () => {
  it('names the signing key in the header and verifies its own tokens', async () => {
    const ring = new JwtKeyRing(jwt, NEW);
    const token = await ring.sign({ sub: 'u1' }, 60);
    expect((jwt.decode(token, { complete: true }) as { header: { kid: string; alg: string } }).header).toMatchObject({ kid: keyId(NEW), alg: 'HS256' });
    expect(await ring.verify<{ sub: string }>(token)).toMatchObject({ sub: 'u1' });
  });

  it('keeps accepting tokens from a previous secret during a rotation, and stops once it is dropped', async () => {
    const before = await new JwtKeyRing(jwt, OLD).sign({ sub: 'u1' }, 60);
    expect(await new JwtKeyRing(jwt, NEW, [OLD]).verify(before)).toMatchObject({ sub: 'u1' });
    expect(await new JwtKeyRing(jwt, NEW).verify(before)).toBeNull();
  });

  it('accepts tokens issued before key ids existed only with the current secret', async () => {
    const legacy = await jwt.signAsync({ sub: 'u1' }, { secret: NEW, expiresIn: 60 });
    expect(await new JwtKeyRing(jwt, NEW).verify(legacy)).toMatchObject({ sub: 'u1' });
    expect(await new JwtKeyRing(jwt, OLD, [NEW]).verify(legacy)).toBeNull();
  });

  it('refuses tokens from another key ring, tampered or expired tokens, and other algorithms', async () => {
    const access = new JwtKeyRing(jwt, NEW);
    const refresh = await new JwtKeyRing(jwt, OLD).sign({ sub: 'u1' }, 60);
    expect(await access.verify(refresh)).toBeNull(); // a refresh token is never an access token
    const token = await access.sign({ sub: 'u1' }, 60);
    expect(await access.verify(`${token.slice(0, -3)}abc`)).toBeNull();
    expect(await access.verify(await access.sign({ sub: 'u1' }, -10))).toBeNull();
    const hs512 = await jwt.signAsync({ sub: 'u1' }, { secret: NEW, algorithm: 'HS512', keyid: keyId(NEW) });
    expect(await access.verify(hs512)).toBeNull();
    expect(await access.verify('not-a-jwt')).toBeNull();
  });

  it('parses the comma-separated list of previous secrets', () => {
    expect(previousSecrets(undefined)).toEqual([]);
    expect(previousSecrets(' a , ,b ')).toEqual(['a', 'b']);
  });
});
