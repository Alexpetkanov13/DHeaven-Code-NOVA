function greet(name, punctuation = '!') {
  const greeting = `Hello, ${name}${punctuation}`;
  return greeting;
}

module.exports = { greet };
