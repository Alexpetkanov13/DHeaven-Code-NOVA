from app.greeter import Greeter, greet

greeter = Greeter(">")
print(greet("NOVA"))
print("\n".join(greeter.greet_all(["Java", "Rust"])))
