export interface CapabilityGuidance {
  denied_by?: string;
  attempted_action?: string;
  capability_profile?: string;
  tool_mode?: string;
  write_state?: string;
  reason?: string;
  remediation?: string;
  workspace?: string;
  project?: string;
}

export function isStructuredCapabilityGuidance(text: string): boolean {
  const normalized = text.trim();
  return normalized.includes('capability_denied: yes')
    && normalized.includes('capability_profile:')
    && normalized.includes('write_state:')
    && normalized.includes('reason:');
}

export function parseCapabilityGuidance(text: string): CapabilityGuidance | null {
  if (!isStructuredCapabilityGuidance(text)) return null;
  const guidance: CapabilityGuidance = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.includes(':')) continue;
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (!value || key === 'capability_denied') continue;
    guidance[key as keyof CapabilityGuidance] = value;
  }
  return guidance;
}
