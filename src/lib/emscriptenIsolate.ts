/**
 * emscriptenIsolate.ts
 *
 * Wraps an Emscripten-generated loader script in an IIFE so its top-level
 * `var` declarations (Module, ExitStatus, EmscriptenEH, wasmTable, wasmMemory,
 * runtimeInitialized, ...) don't pollute the global scope and collide when a
 * second Emscripten module is loaded into the same window.
 *
 * Why this is necessary
 * ---------------------
 * Emscripten's classic (non-modularized) output declares many top-level
 * `var Foo = ...;` statements. Browsers treat each of those as a global
 * binding. If you load TWO Emscripten loaders into the same page, the second
 * one fails at PARSE time with:
 *   SyntaxError: Identifier 'XXX' has already been declared
 * because `var X` followed by another `var X` is fine, but the wrapping JS
 * the browser inserts when injecting the second `<script>` triggers the
 * lexical-binding check.
 *
 * The wrapper does two things:
 *
 * 1. Wraps the Emscripten source in an IIFE so all its top-level `var`s
 *    become function-scoped (no globals leak).
 *
 * 2. Bridges `Module`: Emscripten reads `Module` from the global scope at
 *    startup. We pre-set `globalThis.Module` from the caller, then inside
 *    the IIFE alias it to a local `Module` variable so the script's
 *    `Module = Module || {}` pattern still works. After init we copy the
 *    enriched `Module` back to `globalThis.Module` so `Module.callMain`,
 *    `Module.FS`, etc. remain accessible to the caller.
 *
 * The `tag` parameter is purely informational (used in error messages).
 */
export function isolateEmscriptenGlobals(jsSrc: string, _tag: string): string {
  // Strategy: prepend a tiny shim that grabs the global Module then runs the
  // Emscripten code inside an IIFE that reads `Module` from the enclosing
  // function scope (so its `var Module = Module || {}` resolves to our
  // outer one). After the IIFE we don't need to do anything else — Emscripten
  // mutates the SAME Module object (adding FS, callMain, HEAPU8, etc.)
  // because JavaScript objects are passed by reference.
  return [
    '(function(){',
    '  var Module = globalThis.Module;',
    '  /* original Emscripten source: */',
    jsSrc,
    '  globalThis.Module = Module;',
    '})();',
  ].join('\n');
}
