import { greet, Greeter } from './greeter.js';

const greeter = new Greeter('>');
console.log(greet('NOVA'));
console.log(greeter.greetAll(['Java', 'Rust']).join('\n'));
