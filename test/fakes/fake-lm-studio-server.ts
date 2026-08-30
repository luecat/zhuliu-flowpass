export function createFakeLmStudioServer() {
  let calls = 0;
  return { models: [{ id: 'flowpass-passport' }], get calls() { return calls; }, async complete(): Promise<{ output: string }> { calls += 1; return { output: JSON.stringify({ nodes: [], edges: [] }) }; } };
}
