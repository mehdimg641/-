import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type InboxStatus = RouterOutputs["inbox"]["status"];
export type InboxStats = RouterOutputs["inbox"]["stats"];
