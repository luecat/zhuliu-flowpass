import { describe, expect, it, vi } from 'vitest';
import Page from './page';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

describe('root route', () => {
  it('redirects to the applicant application', async () => {
    const { redirect } = await import('next/navigation');
    Page();
    expect(redirect).toHaveBeenCalledWith('/app/apply');
  });
});
