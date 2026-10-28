const _ = require("lodash/fp");

exports.pick = function (obj, keys) {
  return _.pick(keys)(obj);
};

module.exports.isEmpty = (value) => value == null || value.length === 0;

async function retry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch {
      // try again
    }
  }
  throw new Error(`Failed after ${attempts} attempts`);
}

exports.retry = retry;
