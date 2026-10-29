import { AsyncLocalStorage } from "node:async_hooks";

export type RequestStore = {
  requestId: string;
  signal: AbortSignal;
  readToken: string;
  started: number;
  logged: boolean;
};

export const requestStore = new AsyncLocalStorage<RequestStore>();

export function currentRequest(): RequestStore | undefined {
  return requestStore.getStore();
}
