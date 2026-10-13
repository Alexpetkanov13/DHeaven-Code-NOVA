mod greeter;

use greeter::{greet, Greeter};

fn main() {
    let greeter = Greeter { prefix: ">".to_string() };
    println!("{}", greet("NOVA"));
    println!("{}", greeter.greet_all(&["Java", "Rust"]).join("\n"));
}
