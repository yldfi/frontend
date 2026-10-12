type FetchHandler = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

let currentHandler: FetchHandler = async () => new Response("unconfigured opennext bundle", { status: 200 });

export function setFetchHandler(handler: FetchHandler) {
  currentHandler = handler;
}

export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> =>
    currentHandler(request, env, ctx),
};