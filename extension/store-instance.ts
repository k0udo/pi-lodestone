import { MEMORY_DIR } from "./config.ts";
import { DecisionStore, defaultStoreConfig } from "./storage.ts";

// Single shared decision store for the whole extension. ES module caching makes
// this a process-wide singleton, so every importer sees the same in-memory cache.
export const store = new DecisionStore(defaultStoreConfig(MEMORY_DIR));
