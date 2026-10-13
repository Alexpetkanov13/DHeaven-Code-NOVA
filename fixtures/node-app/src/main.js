const { greet } = require('./greeter');

const names = ['NOVA', 'Java', 'Rust'];
for (const name of names) {
  console.log(greet(name));
}
