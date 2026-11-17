import type { Metric } from "prom-client";

/**
 * Reads one sample from a prom-client metric. For histograms pass the sample name
 * suffix (e.g. "_count"). Returns 0 when the labelled series does not exist yet.
 */
export async function metricValue(
  metric: Metric,
  labels: Record<string, string> = {},
  sampleSuffix = "",
): Promise<number> {
  const { name, values } = await metric.get();

  const sample = values.find(
    (v) =>
      // Histogram samples carry metricName (e.g. *_count); the base type doesn't declare it.
      ((v as { metricName?: string }).metricName ?? name) ===
        `${name}${sampleSuffix}` &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );

  return sample?.value ?? 0;
}
