const express = require("express");
const compression = require("compression");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const config = require("./config/env");
const routes = require("./routes");
const notFound = require("./middlewares/notFound");
const errorHandler = require("./middlewares/errorHandler");
const { UPLOAD_ROOT } = require("./middlewares/upload");
const { clearOnWrite } = require("./utils/dashboardCache");

const app = express();

// Behind a hosting proxy every request arrives from the proxy's address, so the
// per-address rate limits (sign-in, the guest QR pages) would put the whole
// world in one bucket. TRUST_PROXY says how many proxy hops to trust; 0 means
// the app is reached directly, as in development.
app.set("trust proxy", config.trustProxy);

app.use(helmet());
// Live screens (kitchen, deliveries, the bell) poll every few seconds; gzip cuts
// a deliveries board from about 200 KB to about 25 KB on a restaurant's Wi-Fi.
app.use(compression());
// The guests' public API (/api/public: table QR ordering, online ordering,
// booking) answers any web address: it needs no login and carries no cookies,
// so a restaurant can point its own domain at the guests' site without a
// change here. Everything else answers only the apps listed in CORS_ORIGIN.
const isPublicGuestApi = (req) => req.path === "/api/public" || req.path.startsWith("/api/public/");
app.use(cors((req, callback) => callback(null, { origin: isPublicGuestApi(req) ? true : config.corsOrigin })));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

// Uploaded images are plain static files. They are served read-only, with a
// long cache life because each one has a generated, never-reused name.
//
// helmet() sets Cross-Origin-Resource-Policy: same-origin, which would stop the
// frontend loading these images while it runs on its own port. They are public
// pictures of food, so the header is relaxed for this path only.
app.use(
  "/uploads",
  helmet.crossOriginResourcePolicy({ policy: "cross-origin" }),
  express.static(UPLOAD_ROOT, {
    maxAge: "7d",
    index: false,
    dotfiles: "ignore",
  })
);

// The dashboard keeps its answers for a few seconds; any write that succeeds
// throws its restaurant's kept answers away (utils/dashboardCache.js).
app.use("/api", clearOnWrite);
app.use("/api", routes);

// These two must stay last: unmatched routes, then any error thrown above.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
