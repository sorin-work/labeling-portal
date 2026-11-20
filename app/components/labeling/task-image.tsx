import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';

import { SKIP_BROKEN } from '~/domain/skip';

/**
 * What a task shows when its image does not load: a dead link, a host that is
 * down, a file that is not an image. The browser loads task images itself
 * (the server never fetches them), so this is the only place that knows.
 */
export function ImageFailed({ src, readOnly }: { src: string; readOnly?: boolean }) {
  return (
    <div
      role="alert"
      className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
    >
      <p className="font-medium">The image did not load.</p>
      <p className="mt-1 break-all font-mono text-xs">{src || '(no address)'}</p>
      {!readOnly && (
        <p className="mt-1">
          Reload the page to try again. If it still does not load, skip the task with “{SKIP_BROKEN}
          ”.
        </p>
      )}
    </div>
  );
}

/**
 * Tells whether an image failed. A cached image can fail before React
 * listens for `error` (after a reload), so the element is asked as well.
 */
export function useImageFailed(src: string) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const image = ref.current;
    if (image?.complete && image.naturalWidth === 0 && image.currentSrc) setFailed(src);
  }, [src]);
  return { ref, failed: failed === src, onError: () => setFailed(src) };
}

/** The image of a task, or the message that it did not load. */
export function TaskImage({
  src,
  alt,
  readOnly,
  ...props
}: { src: string; alt: string; readOnly?: boolean } & Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'alt'
>) {
  const { ref, failed, onError } = useImageFailed(src);
  if (failed) return <ImageFailed src={src} readOnly={readOnly} />;
  return <img ref={ref} src={src} alt={alt} onError={onError} {...props} />;
}
