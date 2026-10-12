package com.dheaven.demo;

/** Builds greetings. */
public class Greeter {
    private final String prefix;

    public Greeter(String prefix) {
        this.prefix = prefix;
    }

    /** Returns a greeting for {@code name}. */
    public String greet(String name) {
        return prefix + ", " + name + "!";
    }
}
