import type { ClassificationAnswer } from '~/domain/answers';
import type { ImageClassificationSchema } from '~/domain/task-schema';

import type { LabelingProps } from './index';
import { LabelChoices, useLabelChoices } from './label-choices';
import { TaskImage, useImageFailed, useReportImageFailed } from './task-image';

/**
 * Sorting an image into classes: the image, then the same label buttons and
 * keys as a text classification. The browser loads the image from its
 * address; when it does not load, the task says so and points to Skip.
 */
export function ImageClassification({
  schema,
  data,
  value,
  onChange,
  readOnly,
  onImageFailed,
}: LabelingProps<ImageClassificationSchema, ClassificationAnswer>) {
  const src = String(data[schema.imageField] ?? '');
  const image = useImageFailed(src);
  useReportImageFailed(image.failed, onImageFailed);
  // nothing can be labelled on a picture nobody can see: labels and keys are
  // off while it has failed, and the page offers only Skip
  const locked = Boolean(readOnly) || image.failed;
  const { selected, toggle, inUse } = useLabelChoices({
    schema,
    value,
    onChange,
    readOnly: locked,
  });
  return (
    <div className="space-y-5" {...inUse}>
      <TaskImage
        src={src}
        image={image}
        alt="The image to classify"
        readOnly={readOnly}
        className="block max-h-[70vh] max-w-full rounded-md ring-1 ring-slate-200"
      />
      <LabelChoices schema={schema} selected={selected} toggle={toggle} readOnly={locked} />
    </div>
  );
}
