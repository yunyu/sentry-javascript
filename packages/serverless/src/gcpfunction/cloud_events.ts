// '@google-cloud/functions-framework/build/src/functions' import is expected to be type-only so it's erased in the final .js file.
// When TypeScript compiler is upgraded, use `import type` syntax to explicitly assert that we don't want to load a module here.
import {
  CloudEventFunction,
  CloudEventFunctionWithCallback,
} from '@google-cloud/functions-framework/build/src/functions';
import { flush, getCurrentHub, startTransaction } from '@sentry/node';
import { logger } from '@sentry/utils';

import { captureEventError, getActiveDomain, WrapperOptions } from './general';

export type CloudEventFunctionWrapperOptions = WrapperOptions;

/**
 * Wraps an event function handler adding it error capture and tracing capabilities.
 *
 * @param fn Event handler
 * @param options Options
 * @returns Event handler
 */
export function wrapCloudEventFunction(
  fn: CloudEventFunction | CloudEventFunctionWithCallback,
  wrapOptions: Partial<CloudEventFunctionWrapperOptions> = {},
): CloudEventFunctionWithCallback {
  const options: CloudEventFunctionWrapperOptions = {
    flushTimeout: 2000,
    ...wrapOptions,
  };
  return (context, callback) => {
    const transaction = startTransaction({
      name: context.type || '<unknown>',
      op: 'gcp.function.cloud_event',
    });

    // We put the transaction on the scope so users can attach children to it
    getCurrentHub().configureScope(scope => {
      scope.setSpan(transaction);
    });

    const activeDomain = getActiveDomain();

    activeDomain.on('error', err => {
      captureEventError(err, context);
    });

    const newCallback = activeDomain.bind((...args: unknown[]) => {
      if (args[0] !== null && args[0] !== undefined) {
        captureEventError(args[0], context);
      }
      transaction.finish();

      flush(options.flushTimeout)
        .then(() => {
          callback(...args);
        })
        .then(null, e => {
          logger.error(e);
        });
    });

    if (fn.length > 1) {
      return (fn as CloudEventFunctionWithCallback)(context, newCallback);
    }

    Promise.resolve()
      .then(() => (fn as CloudEventFunction)(context))
      .then(
        result => {
          newCallback(null, result);
        },
        err => {
          newCallback(err, undefined);
        },
      );
  };
}
