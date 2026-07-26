Cloudflare Pages needs a build output directory. This one is deliberately empty:
every route is handled by functions/[[path]].js. Static files placed here would
shadow the function and be served publicly.
