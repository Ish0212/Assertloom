module.exports = async function fetchAll(urls) {
  return Promise.all(urls.map((url) => fetch(url)));
};
