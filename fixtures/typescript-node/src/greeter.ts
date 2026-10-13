/** Builds the greeting shown by NOVA fixtures. */
export function greet(name: string, punctuation = '!'): string {
  return `Hello, ${name}${punctuation}`;
}

export class Greeter {
  constructor(private readonly prefix: string) {}
  greetAll(names: string[]): string[] {
    return names.map((n) => `${this.prefix} ${greet(n)}`);
  }
}
