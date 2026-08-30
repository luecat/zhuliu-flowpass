import { describe, expect, it } from 'vitest'; import { clearPublicRuntime } from '../../../../server/public/runtime'; import { GET } from './route';
describe('tasks route boundary', () => { it('fails closed without startup runtime', async () => { clearPublicRuntime(); expect((await GET(new Request('http://127.0.0.1/api/v1/tasks'))).status).toBe(503); }); });
