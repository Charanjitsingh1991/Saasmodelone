import type { ServerResponse } from 'node:http';

export class ClientClosedError extends Error {
  readonly code = 'CLIENT_CLOSED' as const;

  constructor(message = 'Export client closed before the response completed') {
    super(message);
    this.name = 'ClientClosedError';
  }
}

export async function writeWithBackpressure(
  response: ServerResponse,
  chunk: string,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new ClientClosedError();
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    function cleanup(): void {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    }

    function finish(error?: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function onDrain(): void {
      finish();
    }

    function onClose(): void {
      finish(new ClientClosedError());
    }

    function onError(error: Error): void {
      finish(error);
    }

    response.on('drain', onDrain);
    response.on('close', onClose);
    response.on('error', onError);

    try {
      if (response.write(chunk)) {
        finish();
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
