import type { Answer } from '~/domain/answers';
import type { TaskSchema } from '~/domain/task-schema';

export type LabelingProps<S extends TaskSchema = TaskSchema, A = Answer> = {
  schema: S;
  data: Record<string, unknown>;
  value: A | null;
  onChange: (value: A) => void;
  readOnly?: boolean;
};

/** Picks the interface for the project's labeling kind. */
export function LabelingInterface(props: LabelingProps) {
  switch (props.schema.kind) {
    default:
      return (
        <p className="text-sm text-slate-500">This labeling interface is not available yet.</p>
      );
  }
}
