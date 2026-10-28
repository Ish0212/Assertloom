const fs = require("fs");
const { join } = require("path");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const writeJsonFile = (dir, name, data) => {
  fs.writeFileSync(join(dir, name), JSON.stringify(data));
};

module.exports = {
  readJson,
  writeJson: writeJsonFile,
  format(value) {
    return String(value);
  },
};
