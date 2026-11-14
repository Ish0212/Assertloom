class Stack {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
  }

  pop() {
    return this.items.pop();
  }

  static empty() {
    return new Stack();
  }
}

class Queue {
  constructor() {
    this.items = [];
  }

  enqueue(item) {
    this.items.push(item);
  }
}

module.exports = { Stack };
exports.Queue = Queue;
module.exports.Helper = class Helper {
  greet(name) {
    return `hello ${name}`;
  }
};
