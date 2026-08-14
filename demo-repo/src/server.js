const express = require("express");
const userController = require("./userController");

const app = express();

app.get("/users", userController.list);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`pitstop-demo-api listening on ${port}`));
}

module.exports = app;
