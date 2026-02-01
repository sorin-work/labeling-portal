import type {
  Answer,
  BboxAnswer,
  ClassificationAnswer,
  NerAnswer,
  PairwiseAnswer,
} from '~/domain/answers';
import type { TaskSchema } from '~/domain/task-schema';

import { BoundingBoxes } from './bounding-boxes';
import { NerSpans } from './ner';
import { PairwiseRubric } from './pairwise';
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
    case 'ner':
      return (
        <NerSpans
          {...props}
          schema={schema}
          value={value as NerAnswer | null}
          onChange={onChange}
        />
      );
    case 'pairwise':
      return (
        <PairwiseRubric
          {...props}
          schema={schema}
          value={value as PairwiseAnswer | null}
          onChange={onChange}
        />
      );
    case 'bbox':
      return (
        <BoundingBoxes
          {...props}
          schema={schema}
          value={value as BboxAnswer | null}
          onChange={onChange}
        />
      );
  }
}
