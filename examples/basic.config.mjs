// The smallest useful config: build and start a Next.js app, crawl it from two
// entry points, write one offline HTML file.
//
//   node cli.mjs all --config examples/basic.config.mjs --screens
//   open examples/out/my-app.html

export default {
  name: "my-app",
  title: "My App",
  app: {
    cwd: "../../my-app", // the Next.js project, relative to this file
    build: "npx next build", // runs when there is no .next/BUILD_ID, or with --build
    start: "npx next start -p {port}",
    port: 3217,
  },
  out: "./out/my-app.html",
  start: "/", // what the file opens on
  seeds: ["/", "/docs"], // where the crawl starts; links, selects and tabs find the rest
};
