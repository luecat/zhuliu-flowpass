export type LaunchAgent = {
  label: string;
  programArguments: string[];
  runAtLoad?: boolean;
  keepAlive?: boolean;
  calendarInterval?: { Hour: number; Minute: number };
  workingDirectory?: string;
  environmentVariables?: Record<string, string>;
  standardOutPath?: string;
  standardErrorPath?: string;
};

export function assertSafeProgramArguments(args: readonly string[]): void {
  if (!args.length || args.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.includes('\0'))) throw new Error('invalid launch agent arguments');
  if (args.some((arg) => arg.includes(' -c ') || arg === 'sh' || arg === 'bash' || arg === 'zsh')) throw new Error('shell invocation is not allowed');
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderLaunchAgent(agent: LaunchAgent): string {
  assertSafeProgramArguments(agent.programArguments);
  for (const path of [agent.workingDirectory, agent.standardOutPath, agent.standardErrorPath]) {
    if (path && !path.startsWith('/')) throw new Error('launch agent paths must be absolute');
  }
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0"><dict>', `<key>Label</key><string>${xml(agent.label)}</string>`, '<key>ProgramArguments</key><array>', ...agent.programArguments.map((arg) => `<string>${xml(arg)}</string>`), '</array>'];
  if (agent.workingDirectory) lines.push(`<key>WorkingDirectory</key><string>${xml(agent.workingDirectory)}</string>`);
  if (agent.environmentVariables) {
    lines.push('<key>EnvironmentVariables</key><dict>');
    for (const [key, value] of Object.entries(agent.environmentVariables).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`<key>${xml(key)}</key><string>${xml(value)}</string>`);
    }
    lines.push('</dict>');
  }
  if (agent.standardOutPath) lines.push(`<key>StandardOutPath</key><string>${xml(agent.standardOutPath)}</string>`);
  if (agent.standardErrorPath) lines.push(`<key>StandardErrorPath</key><string>${xml(agent.standardErrorPath)}</string>`);
  if (agent.runAtLoad) lines.push('<key>RunAtLoad</key><true/>');
  if (agent.keepAlive) lines.push('<key>KeepAlive</key><true/>');
  if (agent.calendarInterval) lines.push(`<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${agent.calendarInterval.Hour}</integer><key>Minute</key><integer>${agent.calendarInterval.Minute}</integer></dict>`);
  lines.push('</dict></plist>');
  return lines.join('');
}
