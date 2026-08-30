export type LaunchAgent = {
  label: string;
  programArguments: string[];
  runAtLoad?: boolean;
  keepAlive?: boolean;
  calendarInterval?: { Hour: number; Minute: number };
};

export function assertSafeProgramArguments(args: readonly string[]): void {
  if (!args.length || args.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.includes('\0'))) throw new Error('invalid launch agent arguments');
  if (args.some((arg) => arg.includes(' -c ') || arg === 'sh' || arg === 'bash' || arg === 'zsh')) throw new Error('shell invocation is not allowed');
}

export function renderLaunchAgent(agent: LaunchAgent): string {
  assertSafeProgramArguments(agent.programArguments);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0"><dict>', `<key>Label</key><string>${agent.label}</string>`, '<key>ProgramArguments</key><array>', ...agent.programArguments.map((arg) => `<string>${arg.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</string>`), '</array>'];
  if (agent.runAtLoad) lines.push('<key>RunAtLoad</key><true/>'); if (agent.keepAlive) lines.push('<key>KeepAlive</key><true/>'); if (agent.calendarInterval) lines.push(`<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${agent.calendarInterval.Hour}</integer><key>Minute</key><integer>${agent.calendarInterval.Minute}</integer></dict>`); lines.push('</dict></plist>'); return lines.join('');
}
