// @bext-stack/framework/query — bext-native data cache.
//
// Imports
//   import {
//     createQueryClient, createQuery, createMutation,
//   } from "@bext-stack/framework/query";
//
// Server (PRISM page) — prefetch + dehydrate:
//   const client = createQueryClient();
//   await client.prefetchQuery({ queryKey: ["posts"], queryFn });
//   <Raw html={signalsIsland("PostList", PostList, {
//     dehydrate: client.dehydrate(),
//   })} />
//
// Client ("use signals" island) — hydrate + observe:
//   const client = createQueryClient();
//   client.hydrate(props.dehydrate);
//   const posts = createQuery(client, { queryKey: ["posts"], queryFn });
//   // signals JSX reads .value:
//   <p>status: {posts.status.value}</p>
//   <ul>{(posts.data.value ?? []).map(...)}</ul>

export {
  QueryClient,
  createQueryClient,
  hashKey,
} from "./client";
export type {
  ClientOptions,
  DehydratedQuery,
  DehydratedState,
  FetchStatus,
  QueryEntry,
  QueryFilter,
  QueryFunction,
  QueryFunctionContext,
  QueryKey,
  QueryOptions,
  QueryStatus,
} from "./client";

export { createQuery } from "./query";
export type { QueryResult } from "./query";

export { createMutation } from "./mutation";
export type { MutationOptions, MutationResult, MutationStatus } from "./mutation";
