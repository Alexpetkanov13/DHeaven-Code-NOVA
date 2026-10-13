function greet(name, punctuation = '!') {
  return `Hello, ${name}${punctuation}`;
}
module.exports = { greet };
