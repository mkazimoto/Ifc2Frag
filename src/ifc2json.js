#!/usr/bin/env node
/**
 * IFC structure extractor – exports the IFC spatial tree + element properties to JSON.
 *
 * Usage:
 *   node src/ifc2json.js <input.ifc> [output.json] [options]
 *
 * Options:
 *   --props         Include item properties on every node (name, description, global id…)
 *   --psets         Include property sets (IfcPropertySet) on every node
 *   --wasm <path>   Custom path to web-ifc WASM files (default: auto-detect)
 *   --pretty        Pretty-print JSON (default: compact)
 *   -h, --help      Show this help message
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { IfcAPI } from "web-ifc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    input: null,
    output: null,
    includeProps: false,
    includePsets: false,
    wasmPath: null,
    pretty: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--props") {
      options.includeProps = true;
    } else if (arg === "--psets") {
      options.includePsets = true;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--wasm") {
      options.wasmPath = args[++i];
    } else if (!arg.startsWith("--")) {
      if (!options.input) options.input = arg;
      else if (!options.output) options.output = arg;
    }
    i++;
  }

  return options;
}

function printHelp() {
  console.log(`
ifc2json – Extract IFC spatial structure to JSON

Usage:
  ifc2json <input.ifc> [output.json] [options]

Arguments:
  input.ifc       Path to the source IFC file (required)
  output.json     Path for the output JSON file
                  (default: same name/location as input with .json extension)

Options:
  --props         Include base item properties on each node
  --psets         Include IfcPropertySet data on each node (implies --props)
  --pretty        Pretty-print the JSON output (default: compact)
  --wasm <path>   Path to web-ifc WASM directory
  -h, --help      Show this help message

Examples:
  ifc2json model.ifc
  ifc2json model.ifc structure.json --props --psets --pretty
`);
}

// ---------------------------------------------------------------------------
// WASM resolution
// ---------------------------------------------------------------------------
function resolveWasmPath(customPath) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (!fs.existsSync(resolved)) throw new Error(`WASM path not found: ${resolved}`);
    return resolved.endsWith("/") ? resolved : resolved + "/";
  }

  const candidates = [
    path.join(__dirname, "..", "node_modules", "web-ifc"),
    path.join(process.cwd(), "node_modules", "web-ifc"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate + "/";
  }

  throw new Error(
    "Could not locate web-ifc WASM files. Run `npm install` or provide --wasm <path>."
  );
}

// ---------------------------------------------------------------------------
// Helpers to clean up web-ifc value objects into plain values
// ---------------------------------------------------------------------------
function flattenValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(flattenValue);

  // web-ifc wraps primitives as { type, value }
  if ("value" in val && "type" in val) {
    if (val.value === null || val.value === undefined) return null;
    if (typeof val.value === "object") return flattenValue(val.value);
    return val.value;
  }

  // expressID reference – keep as plain number
  if ("expressID" in val && Object.keys(val).length === 1) return val.expressID;

  const result = {};
  for (const [k, v] of Object.entries(val)) {
    if (k === "expressID" || k === "type") continue;
    result[k] = flattenValue(v);
  }
  return result;
}

function cleanProps(raw) {
  if (!raw) return {};
  const out = {};
  const keep = ["GlobalId", "Name", "Description", "ObjectType", "Tag", "LongName", "PredefinedType"];
  for (const key of keep) {
    if (raw[key] !== undefined) {
      const v = flattenValue(raw[key]);
      if (v !== null && v !== undefined) out[key] = v;
    }
  }
  return out;
}

function cleanPset(pset) {
  if (!pset) return null;
  const name = flattenValue(pset.Name);
  const props = {};

  const items = pset.HasProperties || pset.Quantities || [];
  for (const item of items) {
    const pName = flattenValue(item.Name);
    if (!pName) continue;
    const val =
      flattenValue(item.NominalValue) ??
      flattenValue(item.LengthValue) ??
      flattenValue(item.AreaValue) ??
      flattenValue(item.VolumeValue) ??
      flattenValue(item.CountValue) ??
      flattenValue(item.WeightValue) ??
      flattenValue(item.Value) ??
      null;
    props[pName] = val;
  }

  return { name, properties: props };
}

// ---------------------------------------------------------------------------
// Recursive tree builder
// ---------------------------------------------------------------------------
async function buildNode(api, modelID, node, includeProps, includePsets) {
  const out = {
    expressID: node.expressID,
    type: node.type,
  };

  // Always fetch item properties (Name is always included; full props when requested)
  try {
    const raw = await api.properties.getItemProperties(modelID, node.expressID, false);
    if (includeProps || includePsets) {
      Object.assign(out, cleanProps(raw));
    } else {
      const name = flattenValue(raw?.Name);
      if (name !== null && name !== undefined) out.Name = name;
    }
  } catch (_) {
    // some elements may not have base properties
  }

  if (includePsets) {
    try {
      const psets = await api.properties.getPropertySets(modelID, node.expressID, true);
      if (psets && psets.length > 0) {
        out.propertySets = psets.map(cleanPset).filter(Boolean);
      }
    } catch (_) {
      // ignore
    }
  }

  if (node.children && node.children.length > 0) {
    out.children = await Promise.all(
      node.children.map((child) => buildNode(api, modelID, child, includeProps, includePsets))
    );
  } else {
    out.children = [];
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------
async function extract(options) {
  const { input, output, includeProps, includePsets, wasmPath, pretty } = options;

  const inputAbs = path.resolve(input);
  if (!fs.existsSync(inputAbs)) throw new Error(`Input file not found: ${inputAbs}`);

  const outputAbs = output
    ? path.resolve(output)
    : inputAbs.replace(/\.ifc$/i, ".json");

  const outputDir = path.dirname(outputAbs);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Reading: ${inputAbs}`);
  const ifcBytes = new Uint8Array(fs.readFileSync(inputAbs));
  console.log(`  IFC file size: ${(ifcBytes.byteLength / 1024).toFixed(1)} KB`);

  const api = new IfcAPI();
  api.SetWasmPath(resolveWasmPath(wasmPath), true);
  await api.Init();

  const modelID = api.OpenModel(ifcBytes, { COORDINATE_TO_ORIGIN: false });

  console.log("Extracting spatial structure...");
  const startTime = Date.now();

  // getSpatialStructure(modelID, includeProperties) – set false; we fetch manually for control
  const tree = await api.properties.getSpatialStructure(modelID, false);

  const withProps = includeProps || includePsets;
  const root = await buildNode(api, modelID, tree, withProps, includePsets);

  api.CloseModel(modelID);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`  Extraction time: ${elapsed}s`);

  const json = pretty ? JSON.stringify(root, null, 2) : JSON.stringify(root);
  fs.writeFileSync(outputAbs, json, "utf8");
  console.log(`Written: ${outputAbs}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv);

  if (!options.input) {
    console.error("Error: No input file specified.\n");
    printHelp();
    process.exit(1);
  }

  try {
    await extract(options);
    console.log("Done.");
    process.exit(0);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
