import { describe, expect, it } from 'vitest';

import { loader } from '~/routes/healthz';

describe('health check', () => {
  it('reports ok when the database answers', async () => {
    const response = await loader();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' });
  });
});
