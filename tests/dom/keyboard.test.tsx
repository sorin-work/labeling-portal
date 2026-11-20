import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { KeyboardHelp } from '~/components/keyboard-help';
import { LabelingInterface } from '~/components/labeling';
import type { Answer } from '~/domain/answers';

import { expectAccessible } from './axe';
import { KINDS, type Kind } from './fixtures';

/** An interface with its answer in state, the way a page holds it. */
function Labeling({ kind, onAnswer }: { kind: Kind; onAnswer?: (answer: Answer) => void }) {
  const [value, setValue] = useState<Answer | null>(null);
  const { schema, data } = KINDS[kind];
  return (
    <main>
      <LabelingInterface
        schema={schema}
        data={data}
        value={value}
        onChange={(next) => {
          setValue(next);
          onAnswer?.(next);
        }}
      />
    </main>
  );
}

describe('entity text with the keyboard', () => {
  it('walks word by word, extends with Shift and marks with Enter', async () => {
    const user = userEvent.setup();
    let answer: Answer | null = null;
    render(<Labeling kind="ner" onAnswer={(a) => (answer = a)} />);
    const text = screen.getByRole('group', { name: 'Text to label' });

    await user.tab(); // the first entity type button
    while (document.activeElement !== text) await user.tab();
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Ada');

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(screen.getByRole('status').textContent).toBe('Ada Lovelace');
    await user.keyboard('{Enter}');
    expect(answer).toEqual({ spans: [{ start: 0, end: 12, label: 'PERSON' }] });
    expect(screen.getByRole('status').textContent).toBe('Marked PERSON “Ada Lovelace”.');

    // the type key picks the type, then five words on is "London"
    await user.keyboard('2');
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('status').textContent).toBe('London');
    await user.keyboard('{Enter}');
    expect(answer).toEqual({
      spans: [
        { start: 0, end: 12, label: 'PERSON' },
        { start: 25, end: 31, label: 'PLACE' },
      ],
    });
    await expectAccessible();
  });

  it('leaves the arrows and Enter alone while the text does not have focus', async () => {
    const user = userEvent.setup();
    let answer: Answer | null = null;
    render(<Labeling kind="ner" onAnswer={(a) => (answer = a)} />);
    await user.keyboard('{ArrowRight}{Enter}');
    expect(answer).toBeNull();
  });
});

describe('radio groups', () => {
  it('classification labels are one tab stop and the arrows choose', async () => {
    const user = userEvent.setup();
    let answer: Answer | null = null;
    render(<Labeling kind="text_classification" onAnswer={(a) => (answer = a)} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    await user.tab();
    expect(document.activeElement).toBe(radios[0]);
    await user.keyboard('{ArrowRight}');
    expect(answer).toEqual({ labels: ['negative'] });
    await user.tab();
    expect(radios).not.toContain(document.activeElement);
  });

  it('the pairwise preference is a radio group', async () => {
    const user = userEvent.setup();
    let answer: Answer | null = null;
    render(<Labeling kind="pairwise" onAnswer={(a) => (answer = a)} />);
    const preference = screen.getByRole('radio', { name: /A is better/ });
    await user.click(preference);
    await user.keyboard('{ArrowRight}');
    expect(answer).toMatchObject({ preference: 'tie' });
  });
});

describe('the list of shortcuts', () => {
  it('takes focus, keeps Tab inside and gives focus back when it closes', async () => {
    const user = userEvent.setup();
    render(
      <main>
        <button type="button">Before</button>
        <KeyboardHelp page="work" schema={KINDS.bbox.schema} />
      </main>,
    );
    const before = screen.getByRole('button', { name: 'Before' });
    act(() => before.focus());
    await user.keyboard('?');
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await expectAccessible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(before);
  });
});

describe('boxes in words', () => {
  function Boxes({ onAnswer }: { onAnswer: (answer: Answer) => void }) {
    const [value, setValue] = useState<Answer>({
      boxes: [
        { x: 10, y: 20, w: 30, h: 40, label: 'car' },
        { x: 100, y: 50, w: 20, h: 20, label: 'person' },
      ],
      imageWidth: 640,
      imageHeight: 480,
    });
    return (
      <main>
        <LabelingInterface
          schema={KINDS.bbox.schema}
          data={KINDS.bbox.data}
          value={value}
          onChange={(next) => {
            setValue(next);
            onAnswer(next);
          }}
        />
      </main>
    );
  }

  it('lists every box, picks one from the list and edits it with the keys', async () => {
    const user = userEvent.setup();
    let answer: Answer | null = null;
    render(<Boxes onAnswer={(a) => (answer = a)} />);
    const list = screen.getByRole('list', { name: 'Boxes' });
    expect(list.textContent).toContain('car');
    await expectAccessible();

    await user.click(screen.getByRole('button', { name: /^Go to person, box 2 of 2, at 100, 50/ }));
    const box = screen.getByRole('button', { name: /^person, box 2 of 2/, pressed: true });
    expect(document.activeElement).toBe(box);
    await user.keyboard('{ArrowRight}');
    expect(answer).toMatchObject({ boxes: [{ x: 10 }, { x: 101, label: 'person' }] });
    expect(screen.getByRole('status').textContent).toBe(
      'person, box 2 of 2, at 101, 50, 20 by 20 pixels',
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Label of box 1' }), 'person');
    expect(answer).toMatchObject({ boxes: [{ label: 'person' }, {}] });
    expect(screen.getByRole('status').textContent).toBe('Box 1 is now person.');

    await user.click(screen.getByRole('button', { name: 'Remove box 1, person' }));
    expect(screen.getByRole('status').textContent).toBe(
      'Removed the person box. Ctrl + Z puts it back.',
    );
    await user.keyboard('{Control>}z{/Control}');
    expect(answer).toMatchObject({ boxes: [{ x: 10 }, { x: 101 }] });
  });
});

describe('an image that does not load', () => {
  it('says so and points to Skip instead of showing a broken picture', async () => {
    const user = userEvent.setup();
    let answer: Answer | null = null;
    render(<Labeling kind="image_classification" onAnswer={(a) => (answer = a)} />);
    const image = screen.getByRole('img', { name: 'The image to classify' });
    act(() => {
      image.dispatchEvent(new Event('error'));
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The image did not load.');
    expect(alert.textContent).toContain('/street.png');
    expect(alert.textContent).toContain('Content is broken or unreadable');
    expect(screen.queryByRole('img')).toBeNull();
    // the labels stay: what the person sees may still be enough
    await user.keyboard('1');
    expect(answer).toEqual({ labels: ['person'] });
    await expectAccessible();
  });

  it('on a box task says the same, under the picture', () => {
    render(<Labeling kind="bbox" />);
    act(() => {
      screen.getByRole('img', { name: 'Task to label' }).dispatchEvent(new Event('error'));
    });
    expect(screen.getByRole('alert').textContent).toContain('The image did not load.');
  });
});
