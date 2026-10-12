package com.dheaven.demo;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

class GreeterTest {
    @Test
    void greetsByName() {
        assertEquals("Hello, NOVA!", new Greeter("Hello").greet("NOVA"));
    }

    @Test
    void usesPrefix() {
        System.out.println("checking prefix");
        assertEquals("Hi, Ivan!", new Greeter("Hi").greet("Ivan"));
    }

    @Test
    @Disabled("demonstrates a skipped test")
    void notYet() {
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "NOVA_DEMO_FAIL", matches = "1")
    void deliberateFailure() {
        assertEquals("Goodbye, NOVA!", new Greeter("Hello").greet("NOVA"));
    }
}
