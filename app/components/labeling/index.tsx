import type {
  Answer,
  BboxAnswer,
  ClassificationAnswer,
  ImageSize,
  NerAnswer,
  PairwiseAnswer,
} from '~/domain/answers';
import type { TaskSchema } from '~/domain/task-schema';

import { BoundingBoxes } from './bounding-boxes';
import { ImageClassification } from './image-classification';
import { NerSpans } from './ner';
import { PairwiseRubric } from './pairwise';
import { TextClassification } from './text-classification';

export type LabelingProps<S extends TaskSchema = TaskSchema, A = Answer> = {
  schema: S;
  data: Record<string, unknown>;
  value: A | null;
  onChange: (value: A) => void;
  readOnly?: boolean;
  /** Box projects: called when the image has loaded and its size is known. */
  onImageSize?: (size: ImageSize) => void;
  /**
   * Box projects: a name for this picture (the assignment's id), under which
   * zoom and position are kept for the session. They are never part of the
   * answer.
   */
  viewKey?: string;
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
    case 'image_classification':
      return (
        <ImageClassification
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
