/* Simple Next.js server for tests/dev that does not exit when stdin closes. */
const { createServer } = require("http");
const next = require("next");

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    createServer((req, res) => {
      handle(req, res);
    }).listen(port, hostname, () => {
      console.log(`> Ready on http://${hostname}:${port} (dev=${dev})`);
    });
  })
  .catch((err) => {
    console.error("Failed to start Next server", err);
    process.exit(1);
  });
