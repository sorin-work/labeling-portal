import type { ClassificationAnswer } from '~/domain/answers';
import type { TextClassificationSchema } from '~/domain/task-schema';

import type { LabelingProps } from './index';
import { LabelChoices, useLabelChoices } from './label-choices';

export function TextClassification({
  schema,
  data,
  value,
  onChange,
  readOnly,
}: LabelingProps<TextClassificationSchema, ClassificationAnswer>) {
  const text = String(data[schema.textField] ?? '');
  const { selected, toggle, inUse } = useLabelChoices({ schema, value, onChange, readOnly });
  return (
    <div className="space-y-5" {...inUse}>
      <p className="whitespace-pre-wrap text-base leading-7">{text}</p>
      <LabelChoices schema={schema} selected={selected} toggle={toggle} readOnly={readOnly} />
    </div>
  );
}
