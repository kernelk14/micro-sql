import crypto from 'node:crypto';
import { SqlError, ErrorCodes } from '../../errors.js';

/**
 * SCRAM-SHA-256 client for PostgreSQL's SASL authentication.
 *
 * Implements the client side of RFC 5802/7677: the server sends a nonce, salt
 * and iteration count, the client proves knowledge of the password with an
 * HMAC, and the server's signature is verified before the connection is
 * trusted.
 */
export class ScramSha256 {
  /** @param {string} password */
  constructor(password) {
    this.password = String(password ?? '').normalize('NFKC');
    this.nonce = crypto.randomBytes(18).toString('base64');
    this.clientFirstBare = `n=,r=${this.nonce}`;
    this.serverFirst = null;
    this.expectedServerSignature = null;
  }

  /** The `client-first-message`, sent as the SASL initial response. */
  get initialResponse() {
    return `n,,${this.clientFirstBare}`;
  }

  /**
   * Compute the `client-final-message` from the server's first message.
   * @param {string} serverFirst
   * @returns {string}
   */
  continue(serverFirst) {
    this.serverFirst = serverFirst;
    const attributes = parseAttributes(serverFirst);
    const nonce = attributes.r;
    if (!nonce || !nonce.startsWith(this.nonce)) {
      throw new SqlError(ErrorCodes.DRIVER_ERROR, 'The PostgreSQL server sent an invalid SCRAM nonce.');
    }
    const salt = Buffer.from(attributes.s || '', 'base64');
    const iterations = Number(attributes.i);
    if (salt.length === 0 || !Number.isInteger(iterations) || iterations < 1) {
      throw new SqlError(ErrorCodes.DRIVER_ERROR, 'The PostgreSQL server sent invalid SCRAM salt or iterations.');
    }

    const suffix = `c=biws,r=${nonce}`;
    this.authMessage = `${this.clientFirstBare},${serverFirst},${suffix}`;

    const salted = crypto.pbkdf2Sync(this.password, salt, iterations, 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const clientSignature = hmac(storedKey, this.authMessage);
    this.expectedServerSignature = hmac(hmac(salted, 'Server Key'), this.authMessage);

    const proof = Buffer.alloc(clientKey.length);
    for (let i = 0; i < clientKey.length; i += 1) proof[i] = clientKey[i] ^ clientSignature[i];

    return `${suffix},p=${proof.toString('base64')}`;
  }

  /**
   * Verify the `server-final-message`.
   * @param {string} serverFinal
   */
  finish(serverFinal) {
    const attributes = parseAttributes(serverFinal);
    if (attributes.e) {
      throw new SqlError(ErrorCodes.DRIVER_ERROR, `PostgreSQL authentication failed: ${attributes.e}`);
    }
    const signature = Buffer.from(attributes.v || '', 'base64');
    if (
      !this.expectedServerSignature ||
      signature.length !== this.expectedServerSignature.length ||
      !crypto.timingSafeEqual(signature, this.expectedServerSignature)
    ) {
      throw new SqlError(
        ErrorCodes.DRIVER_ERROR,
        'The PostgreSQL server sent an invalid SCRAM signature.'
      );
    }
  }
}

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

function parseAttributes(message) {
  /** @type {Record<string, string>} */
  const attributes = {};
  for (const part of message.split(',')) {
    const index = part.indexOf('=');
    if (index > 0) attributes[part.slice(0, index)] = part.slice(index + 1);
  }
  return attributes;
}
