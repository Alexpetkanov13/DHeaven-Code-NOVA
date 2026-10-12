package com.dheaven.demo

/** Builds greetings. */
class Greeter(private val prefix: String) {
    fun greet(name: String): String = "$prefix, $name!"
}
