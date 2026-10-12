declare module "*.js" {
  const openNextWorker: {
    fetch: (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
  };
  export default openNextWorker;
}