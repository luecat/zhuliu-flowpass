export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { bootstrapPublicRuntime } = await import('./server/public/bootstrap');
  await bootstrapPublicRuntime();
}
