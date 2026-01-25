import type { Answer, ClassificationAnswer } from '~/domain/answers';
import type { TaskSchema } from '~/domain/task-schema';

import { TextClassification } from './text-classification';

export type LabelingProps<S extends TaskSchema = TaskSchema, A = Answer> = {
  schema: S;
  data: Record<string, unknown>;
  value: A | null;
  onChange: (value: A) => void;
  readOnly?: boolean;
};

/** Picks the interface for the project's labeling kind. */
export function LabelingInterface(props: LabelingProps) {
  const { schema, value, onChange } = props;
  switch (schema.kind) {
    case 'text_classification':
      return (
        <TextClassification
          {...props}
          schema={schema}
          value={value as ClassificationAnswer | null}
          onChange={onChange}
        />
      );
    default:
      return (
        <p className="text-sm text-slate-500">This labeling interface is not available yet.</p>
      );
  }
}
