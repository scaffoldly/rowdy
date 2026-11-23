import type { Call } from '../run';
import { observable } from './observable';
import { promise } from './promise';
import { value } from './value';

/** How to trace one kind of value a method returns, until the run it belongs to ends. */
export interface Result<T> {
  matches(returned: unknown): returned is T;
  trace(returned: T, call: Call): unknown;
}

/** The first that matches traces what a method returned. */
export const RESULTS: Result<never>[] = [observable, promise, value] as Result<never>[];
