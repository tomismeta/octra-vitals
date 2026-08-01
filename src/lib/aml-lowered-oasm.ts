export interface JdestLabelHit {
  label: string;
  line: number;
}

export interface JdestLabelInspection {
  labels: number;
  duplicates: JdestLabelHit[][];
}

export function inspectJdestLabels(loweredOasm: string): JdestLabelInspection {
  const labels = new Map<string, JdestLabelHit[]>();
  loweredOasm.split(/\r?\n/).forEach((line, index) => {
    const match = /^JDEST\s+([0-9]+)\s*$/.exec(line.trim());
    if (!match) return;
    const label = match[1] || "";
    if (!label) return;
    const hits = labels.get(label) || [];
    hits.push({ label, line: index + 1 });
    labels.set(label, hits);
  });
  return {
    labels: labels.size,
    duplicates: [...labels.values()].filter((hits) => hits.length > 1)
  };
}

export function assertNoDuplicateJdestLabels(loweredOasm: string): JdestLabelInspection {
  const inspection = inspectJdestLabels(loweredOasm);
  if (inspection.duplicates.length) {
    const detail = inspection.duplicates
      .map((hits) => `${hits[0]?.label}: lines ${hits.map((hit) => hit.line).join(", ")}`)
      .join("; ");
    throw new Error(`lowered AML has duplicate JDEST labels: ${detail}`);
  }
  return inspection;
}
