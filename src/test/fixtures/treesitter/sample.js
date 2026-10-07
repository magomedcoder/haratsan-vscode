function greet(name) {
  return 'привет' + name;
}

class Person {
  constructor(name) {
    this.name = name;
  }

  hello() {
    return greet(this.name);
  }
}
