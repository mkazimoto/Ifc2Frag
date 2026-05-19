#!/usr/bin/env node
/**
 * IFC to .frag converter for ThatOpen engine
 *
 * Usage:
 *   node src/index.js <input.ifc> [output.frag]
 *   node src/index.js --help
 *
 * Options:
 *   --raw           Output uncompressed .frag (default: compressed)
 *   --all-attrs     Include all IFC attributes
 *   --all-rels      Include all IFC relations
 *   --wasm <path>   Custom path to web-ifc WASM files (default: auto-detect)
 *   --id <uuid>     Custom model UUID
 */

import { IfcImporter } from "@thatopen/fragments";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    input: null,
    output: null,
    raw: false,
    allAttributes: false,
    allRelations: false,
    wasmPath: null,
    modelId: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--raw") {
      options.raw = true;
    } else if (arg === "--all-attrs") {
      options.allAttributes = true;
    } else if (arg === "--all-rels") {
      options.allRelations = true;
    } else if (arg === "--wasm") {
      options.wasmPath = args[++i];
    } else if (arg === "--id") {
      options.modelId = args[++i];
    } else if (!arg.startsWith("--")) {
      if (!options.input) {
        options.input = arg;
      } else if (!options.output) {
        options.output = arg;
      }
    }
    i++;
  }

  return options;
}

function printHelp() {
  console.log(`
ifc2frag – Convert IFC files to ThatOpen .frag format

Usage:
  ifc2frag <input.ifc> [output.frag] [options]

Arguments:
  input.ifc       Path to the source IFC file (required)
  output.frag     Path for the output .frag file
                  (default: same name/location as input with .frag extension)

Options:
  --raw           Write uncompressed fragments (larger file, no zlib inflate needed)
  --all-attrs     Serialize all IFC attributes (larger output, more data)
  --all-rels      Serialize all IFC relations  (larger output, more data)
  --wasm <path>   Path to web-ifc WASM directory (default: node_modules/web-ifc/)
  --id <uuid>     Override the model UUID embedded in the fragment file
  -h, --help      Show this help message

Examples:
  ifc2frag model.ifc
  ifc2frag model.ifc output/model.frag
  ifc2frag model.ifc model.frag --all-attrs --all-rels
  ifc2frag model.ifc model.frag --wasm ./wasm/
`);
}

// ---------------------------------------------------------------------------
// WASM path resolution
// ---------------------------------------------------------------------------
function resolveWasmPath(customPath) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`WASM path does not exist: ${resolved}`);
    }
    // web-ifc expects the path to end with /
    return resolved.endsWith("/") ? resolved : resolved + "/";
  }

  // Try to locate web-ifc in node_modules relative to this script, then cwd
  const candidates = [
    path.join(__dirname, "..", "node_modules", "web-ifc"),
    path.join(process.cwd(), "node_modules", "web-ifc"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate + "/";
    }
  }

  throw new Error(
    "Could not locate web-ifc WASM files. " +
      "Run `npm install` or provide --wasm <path> manually."
  );
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------
async function convert(options) {
  const { input, output, raw, allAttributes, allRelations, wasmPath, modelId } =
    options;

  // Resolve output path
  const inputAbs = path.resolve(input);
  const outputAbs = output
    ? path.resolve(output)
    : inputAbs.replace(/\.ifc$/i, ".frag");

  // Ensure output directory exists
  const outputDir = path.dirname(outputAbs);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Read IFC file
  console.log(`Reading: ${inputAbs}`);
  if (!fs.existsSync(inputAbs)) {
    throw new Error(`Input file not found: ${inputAbs}`);
  }
  const ifcBytes = new Uint8Array(fs.readFileSync(inputAbs));
  console.log(`  IFC file size: ${(ifcBytes.byteLength / 1024).toFixed(1)} KB`);

  // Configure importer
  const importer = new IfcImporter();

  const resolvedWasm = resolveWasmPath(wasmPath);
  importer.wasm.path = resolvedWasm;
  importer.wasm.absolute = true;

  if (modelId) {
    // model ID will be passed via process data
  }

  if (allAttributes) {
    importer.addAllAttributes();
  }

  if (allRelations) {
    importer.addAllRelations();
  }

  // Convert
  console.log("Converting IFC → frag...");
  const startTime = Date.now();

  const fragBytes = await importer.process({
    bytes: ifcBytes,
    raw,
    ...(modelId ? { id: modelId } : {}),
    progressCallback: (progress, detail) => {
      const pct = Math.round(progress * 100);
      const stage = detail?.process ?? "";
      const state = detail?.state ?? "";
      process.stdout.write(`\r  [${pct.toString().padStart(3)}%] ${stage} ${state}        `);
    },
  });

  process.stdout.write("\n");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`  Conversion time: ${elapsed}s`);
  console.log(
    `  Output size: ${(fragBytes.byteLength / 1024).toFixed(1)} KB${raw ? " (uncompressed)" : " (compressed)"}`
  );

  // Write output
  fs.writeFileSync(outputAbs, fragBytes);
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
    await convert(options);
    console.log("Done.");
    process.exit(0);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
