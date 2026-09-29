import { type QueryClient } from "@tanstack/react-query";
import { type Me } from "../api";

/** Removing queries cancels their work, so late reads cannot restore old data. */
export function resetAccount(queryClient: QueryClient, me: Me | null = null) {
  // Notify the mounted auth observer before clear detaches it from its query.
  queryClient.setQueryData<Me | null>(["me"], me);
  queryClient.clear();
  queryClient.setQueryData<Me | null>(["me"], me);
}
