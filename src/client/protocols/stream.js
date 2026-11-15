import net from 'node:net';
import tls from 'node:tls';
import { SqlError, ErrorCodes } from '../../errors.js';
import { tlsPolicy, tlsOptions } from './options.js';

/**
 * Buffered frame reader for a socket.
 *
 * `frameSize(buffer)` returns the total byte length of the next frame, or
 * `null` while more bytes are needed. One read is outstanding at a time,
 * which is how these protocols are used.
 *
 * @param {import('node:net').Socket} socket
 * @param {(buffer: Buffer) => number|null} frameSize
 */
export function createReader(socket, frameSize) {
  let buffer = Buffer.alloc(0);
  /** @type {{ resolve: (frame: Buffer) => void, reject: (error: Error) => void } | null} */
  let waiting = null;
  /** @type {Error | null} */
  let failure = null;

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.on('error', (error) => fail(error));
  socket.on('close', () => fail(new Error('The database closed the connection.')));

  function fail(error) {
    if (failure) return;
    failure = error;
    if (waiting) {
      const current = waiting;
      waiting = null;
      current.reject(error);
    }
  }

  function take() {
    if (buffer.length === 0) return null;
    const size = frameSize(buffer);
    if (size === null || buffer.length < size) return null;
    const frame = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return frame;
  }

  function pump() {
    if (!waiting) return;
    const frame = take();
    if (!frame) return;
    const current = waiting;
    waiting = null;
    current.resolve(frame);
  }

  return {
    /** Resolve with the next complete frame. */
    async read() {
      if (failure) throw failure;
      const frame = take();
      if (frame) return frame;
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    }
  };
}

/**
 * Open a TCP connection, optionally negotiating TLS.
 *
 * PostgreSQL uses an explicit SSLRequest byte before the startup message, so
 * pass `{ negotiate: true }` there. MySQL starts TLS as soon as it is
 * configured, so `{ negotiate: true }` is not used for it.
 *
 * @param {Record<string, any>} settings resolved connection settings
 * @param {{ negotiate?: boolean, ssl?: boolean }} [options]
 * @returns {Promise<import('node:net').Socket>}
 */
export async function openStream(settings, options = {}) {
  const socket = await openTcp(settings);
  const policy = options.ssl === false ? 'disable' : tlsPolicy(settings.sslmode);

  if (policy === 'disable') return socket;

  if (options.negotiate) {
    const accepted = await requestTls(socket, settings);
    if (!accepted) return socket;
  }

  return secureSocket(socket, settings, policy);
}

async function openTcp(settings) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: settings.host, port: settings.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new SqlError(
          ErrorCodes.DRIVER_ERROR,
          `Timed out connecting to ${settings.host}:${settings.port} after ${settings.connectTimeout}ms.`
        )
      );
    }, settings.connectTimeout);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(connectionError(settings, error));
    });
  });
}

/**
 * Send the PostgreSQL SSLRequest and read the single-byte answer.
 * @returns {Promise<boolean>} whether the server agreed to TLS
 */
async function requestTls(socket, settings) {
  // SSLRequest: length 8, code 80877103.
  const request = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
  await new Promise((resolve, reject) => {
    socket.write(request, (error) => (error ? reject(connectionError(settings, error)) : resolve()));
  });

  const answer = await new Promise((resolve, reject) => {
    const onData = (chunk) => cleanup(resolve, chunk[0]);
    const onError = (error) => cleanup(reject, connectionError(settings, error));
    const onClose = () => cleanup(reject, new Error('The database closed the connection during TLS negotiation.'));
    function cleanup(done, value) {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      done(value);
    }
    socket.once('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });

  if (answer === 0x53) return true; // 'S'
  if (answer === 0x4e) return false; // 'N'
  throw new SqlError(ErrorCodes.DRIVER_ERROR, 'The server sent an unexpected answer to the TLS request.');
}

async function secureSocket(socket, settings, policy) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ ...tlsOptions(settings, policy), socket });
    secure.setNoDelay(true);
    secure.once('secureConnect', () => {
      secure.removeAllListeners('error');
      resolve(secure);
    });
    secure.once('error', (error) => {
      secure.destroy();
      reject(new SqlError(ErrorCodes.DRIVER_ERROR, `TLS handshake failed: ${error.message}`));
    });
  });
}

function connectionError(settings, error) {
  const wrapped = new SqlError(
    ErrorCodes.DRIVER_ERROR,
    `Could not connect to ${settings.host}:${settings.port}: ${error.message}`
  );
  wrapped.cause = error;
  return wrapped;
}
