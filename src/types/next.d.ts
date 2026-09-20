import 'next/server';

declare module 'next/server' {
  export function after(task: () => Promise<void> | void): void;
  export function unstable_after(task: () => Promise<void> | void): void;
}
