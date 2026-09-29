import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  ROOT_CONTEXT,
  trace,
  type Context,
  type ContextManager,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";

// SDK なしの API は context を保持しない（Noop の ContextManager）。本番の既定の読み方
// （trace.getActiveSpan()、context.active()）のままテストするため、最小の manager を置く。
class TestContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}

/** テストの間だけ context を保持する。戻り値で元に戻す。 */
export const installTestContextManager = () => {
  context.setGlobalContextManager(new TestContextManager());
  return () => {
    context.disable();
  };
};

export type RecordedSpanEvent = {
  name: string;
  attributes: Record<string, unknown> | undefined;
};

/** 記録された呼び出しを確かめるための span。属性の設定も捕まえる。 */
export const createRecordingSpan = (
  spanContext: SpanContext = {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    traceFlags: 1,
  },
) => {
  const events: RecordedSpanEvent[] = [];
  const attributes: Record<string, unknown> = {};
  const span = {
    spanContext: () => spanContext,
    addEvent: (name: string, eventAttributes?: Record<string, unknown>) => {
      events.push({ name, attributes: eventAttributes });
      return span;
    },
    setAttribute: (key: string, value: unknown) => {
      attributes[key] = value;
      return span;
    },
    setAttributes: (values: Record<string, unknown>) => {
      Object.assign(attributes, values);
      return span;
    },
    recordException: () => {
      throw new Error("recordException must not be used");
    },
  };
  return { span: span as unknown as Span, events, attributes };
};

export const withActiveSpan = <T>(
  span: Span,
  operation: () => T,
  parent: Context = context.active(),
): T => context.with(trace.setSpan(parent, span), operation);
