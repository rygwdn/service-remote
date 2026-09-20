import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as screenshotWs from '../../src/screenshot-ws';

type ScreenshotResult = { imageData: string };

class FakeOBSWebSocket {
  static instance: FakeOBSWebSocket;
  readonly screenshotCalls: Array<Record<string, unknown>> = [];
  readonly screenshotResults: Array<Promise<ScreenshotResult>> = [];
  private readonly screenshotStartResolvers: Array<() => void> = [];
  private readonly handlers = new Map<string, Array<(payload?: unknown) => void>>();

  constructor() {
    FakeOBSWebSocket.instance = this;
  }

  waitForScreenshotStart(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.screenshotStartResolvers.push(resolve);
    return promise;
  }

  on(event: string, handler: (payload?: unknown) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async connect(): Promise<void> {}

  disconnect(): void {
    for (const handler of this.handlers.get('ConnectionClosed') ?? []) handler();
  }

  async call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === 'GetSceneList') return { scenes: [{ sceneName: 'Main' }], currentProgramSceneName: 'Main' };
    if (method === 'GetStreamStatus' || method === 'GetRecordStatus') return { outputActive: false };
    if (method === 'GetSceneItemList' || method === 'GetGroupSceneItemList') return { sceneItems: [] };
    if (method === 'GetInputList') return { inputs: [] };
    if (method === 'GetSourceScreenshot') {
      this.screenshotStartResolvers.shift()?.();
      this.screenshotCalls.push(params ?? {});
      const result = this.screenshotResults.shift();
      if (!result) return { imageData: 'data:image/jpeg;base64,ZmFrZQ==' };
      return result;
    }
    if (method === 'GetSourcePrivateSettings') return { sourcePrivateSettings: {} };
    return {};
  }
}

mock.module('obs-websocket-js', () => ({ default: FakeOBSWebSocket }));
const { default: obsConnection } = await import('../../src/connections/obs');

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  return Promise.withResolvers<T>();
}


describe('OBS screenshot capture', () => {
  beforeEach(() => {
    obsConnection.disconnect();
    FakeOBSWebSocket.instance.screenshotCalls.length = 0;
    FakeOBSWebSocket.instance.screenshotResults.length = 0;
    screenshotWs.setPublisher(() => {});
  });

  afterAll(() => {
    obsConnection.disconnect();
    screenshotWs.setPublisher(() => {});
    mock.restore();
  });

  test('getSceneScreenshot uses OBS and decodes the returned JPEG', async () => {
    const fake = FakeOBSWebSocket.instance;
    const image = Buffer.from('jpeg bytes');
    fake.screenshotResults.push(Promise.resolve({ imageData: `data:image/jpeg;base64,${image.toString('base64')}` }));

    const result = await obsConnection.getSceneScreenshot('Main');

    expect(result).toEqual(image);
    expect(fake.screenshotCalls[0]).toEqual({
      sourceName: 'Main',
      imageFormat: 'jpeg',
      imageWidth: 320,
      imageCompressionQuality: 50,
    });
  });

  test('does not start a second screenshot while the first is pending', async () => {
    const fake = FakeOBSWebSocket.instance;
    const first = deferred<ScreenshotResult>();
    const started = fake.waitForScreenshotStart();
    fake.screenshotResults.push(first.promise);
    await obsConnection.connect();
    await started;

    expect(fake.screenshotCalls).toHaveLength(1);
    await Promise.resolve();
    expect(fake.screenshotCalls).toHaveLength(1);
    obsConnection.disconnect();
    first.resolve({ imageData: 'data:image/jpeg;base64,ZmFrZQ==' });
    await first.promise;
  });

  test('disconnect suppresses publication from a screenshot that completes later', async () => {
    const fake = FakeOBSWebSocket.instance;
    const pending = deferred<ScreenshotResult>();
    const started = fake.waitForScreenshotStart();
    fake.screenshotResults.push(pending.promise);
    const frames: Buffer[] = [];
    screenshotWs.setPublisher((frame) => frames.push(frame));

    await obsConnection.connect();
    await started;
    expect(fake.screenshotCalls).toHaveLength(1);

    obsConnection.disconnect();
    pending.resolve({ imageData: 'data:image/jpeg;base64,ZmFrZQ==' });
    await pending.promise;
    await Promise.resolve();

    expect(frames).toHaveLength(0);
  });
});
