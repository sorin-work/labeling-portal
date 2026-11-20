import { Button } from './ui';

/**
 * A suggested answer, shown as a suggestion: a dashed, labelled box above the
 * task. It becomes the answer only when the annotator presses "Start from the
 * suggestion", and what they hand in is then what they checked or changed.
 * Nothing is filled in by itself, so a task with a suggestion is not one key
 * press away from being handed in.
 */
export function SuggestionNote({
  text,
  taken,
  hasAnswer,
  onTake,
}: {
  text: string;
  taken: boolean;
  /** the annotator has an answer already (a restored draft): taking the suggestion replaces it */
  hasAnswer: boolean;
  onTake: () => void;
}) {
  return (
    <div className="rounded-md border-2 border-dashed border-slate-300 bg-white px-4 py-3 text-sm">
      <p>
        <span className="font-medium">Suggestion</span>{' '}
        <span className="text-slate-600">(made by a rule or a model, not by a person):</span> {text}
      </p>
      {taken ? (
        <p className="mt-1 text-slate-600" role="status">
          You started from the suggestion. Check every part of it, and change what is wrong before
          you submit.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              if (hasAnswer && !confirm('Replace your answer so far with the suggestion?')) return;
              onTake();
            }}
          >
            {hasAnswer ? 'Replace my answer with the suggestion' : 'Start from the suggestion'}
          </Button>
          <span className="text-xs text-slate-500">Or answer on your own below.</span>
        </div>
      )}
    </div>
  );
}
