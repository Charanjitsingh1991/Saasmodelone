import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { ClientClosedError, writeWithBackpressure } from '@saasmodels/api';

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes: string[] = [];
  writeResult = true;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.writeResult;
  }
}

function fakeResponse(): FakeResponse {
  return new FakeResponse();
}

function asResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

describe('CSV stream writer', () => {
  test('writes immediately when the response is ready', async () => {
    const response = fakeResponse();
    await writeWithBackpressure(asResponse(response), 'a');
    expect(response.writes).toEqual(['a']);
  });

  test('waits for drain when the response applies backpressure', async () => {
    const response = fakeResponse();
    response.writeResult = false;
    let settled = false;
    const pending = writeWithBackpressure(asResponse(response), 'a');
    void pending.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(response.writes).toEqual(['a']);

    response.emit('drain');
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  test('rejects when the client closes during backpressure', async () => {
    const response = fakeResponse();
    response.writeResult = false;
    const pending = writeWithBackpressure(asResponse(response), 'a');
    response.emit('close');
    await expect(pending).rejects.toBeInstanceOf(ClientClosedError);
  });

  test('rejects before writing to a destroyed response', async () => {
    const response = fakeResponse();
    response.destroyed = true;
    await expect(writeWithBackpressure(asResponse(response), 'a')).rejects.toBeInstanceOf(
      ClientClosedError,
    );
    expect(response.writes).toEqual([]);
  });

  test('rejects when the response emits an error', async () => {
    const response = fakeResponse();
    response.writeResult = false;
    const pending = writeWithBackpressure(asResponse(response), 'a');
    response.emit('error', new Error('socket failed'));
    await expect(pending).rejects.toThrow('socket failed');
  });
});
