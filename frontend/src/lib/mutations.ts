import { ApiError } from "../api";

/**
 * Update/delete endpoints answer 404 when the row no longer exists (already
 * deleted in another tab, a double-tapped delete, or an id that was never ours).
 * That is not an error the user can act on: the right response is to drop any
 * stale local state and refetch, which `onNotFound` does.
 */
export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/**
 * Build a `useMutation` `onError` handler: 404 → `onNotFound()` (refetch, close
 * editors, no error message); anything else → `onOtherError(error)`.
 */
export function notFoundAware(onNotFound: () => void, onOtherError?: (error: unknown) => void) {
  return (error: unknown) => {
    if (isNotFound(error)) onNotFound();
    else onOtherError?.(error);
  };
}
