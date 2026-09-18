const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const config = require("./config/env");
const routes = require("./routes");
const notFound = require("./middlewares/notFound");
const errorHandler = require("./middlewares/errorHandler");

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.use("/api", routes);

// These two must stay last: unmatched routes, then any error thrown above.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
