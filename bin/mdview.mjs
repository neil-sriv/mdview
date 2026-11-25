#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { register } from "node:module";

// peanut ships TypeScript. Node will not strip it inside node_modules, so the
// loader has to be in place before the app's imports run.
register(new URL("../lib/peanut-loader.mjs", import.meta.url));
await import("./mdview-main.mjs");
