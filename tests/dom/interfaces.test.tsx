import { render } from '@testing-library/react';
import { describe, it } from 'vitest';

import { LabelingInterface } from '~/components/labeling';

import { expectAccessible } from './axe';
import { KIND_NAMES, KINDS } from './fixtures';

describe('labeling interfaces', () => {
  for (const kind of KIND_NAMES) {
    for (const readOnly of [false, true]) {
      it(`${kind}${readOnly ? ', read-only,' : ''} has no axe violations`, async () => {
        const { schema, data } = KINDS[kind];
        const { container } = render(
          <main>
            <LabelingInterface
              schema={schema}
              data={data}
              value={null}
              onChange={() => {}}
              readOnly={readOnly}
            />
          </main>,
        );
        await expectAccessible(container);
      });
    }
  }
});
