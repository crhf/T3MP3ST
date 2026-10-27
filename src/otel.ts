/**
 * OpenTelemetry bootstrap (OTEL first-light).
 *
 * This module MUST be imported before anything that creates an LLMBackbone,
 * so the global tracer provider is registered before the first `chat()` span.
 * It is the first import in src/cli.ts for exactly that reason.
 *
 * It is a no-op unless telemetry is explicitly enabled, so normal runs pay
 * nothing: enable by setting either
 *   - T3MP3ST_OTEL=1            (uses OTEL_EXPORTER_OTLP_ENDPOINT or the default below), or
 *   - OTEL_EXPORTER_OTLP_ENDPOINT=http://host:4318   (presence alone enables it)
 *
 * Spans are exported over OTLP/HTTP. Point it at a local Jaeger all-in-one
 * (native OTLP on :4318, UI on :16686) to see traces:
 *   docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
 *
 * Any failure here is swallowed — telemetry must never break a mission.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/** True once the SDK has been started in this process. */
export let otelEnabled = false;

function telemetryRequested(): boolean {
  return process.env.T3MP3ST_OTEL === '1' || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

if (telemetryRequested()) {
  try {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 't3mp3st',
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version || 'dev',
      }),
      // OTLPTraceExporter appends /v1/traces to the base endpoint itself.
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    });
    sdk.start();
    otelEnabled = true;

    const shutdown = () => {
      sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    // Flush buffered spans on a clean exit so short CLI runs don't lose traces.
    process.once('beforeExit', () => { sdk.shutdown().catch(() => {}); });

    // eslint-disable-next-line no-console
    console.error(`[otel] telemetry enabled → ${endpoint}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[otel] failed to start, continuing without telemetry:', (err as Error).message);
  }
}
