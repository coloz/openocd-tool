#!/usr/bin/env node
"use strict";

const path = require("path");
const { detect, flashFirmware } = require("../lib");

const HELP_TEXT = `
openocd-tool - STM32/GD32 debug probe detection & firmware flashing tool

Usage:
  openocd-tool <command> [options]

Commands:
  detect                Detect connected debug probes (ST-Link / DAPLink)
  flash <firmware>      Flash firmware to target chip

Detect options:
      --json                Output detection result in JSON format

Flash options:
  -t, --target <name>       Target chip (required), e.g. stm32f1x, stm32f4x, gd32e23x
  -i, --interface <type>    Debug interface: stlink (default) or cmsis-dap
  -p, --transport <type>    Transport protocol: swd (default) or jtag
  -s, --speed <kHz>         Adapter speed, default 4000
  -a, --address <hex>       Base address for .bin files, default 0x08000000
      --no-verify           Skip verification after programming
      --no-reset            Do not reset after programming
      --erase-all           Full chip erase
      --timeout <ms>        Timeout in milliseconds, default 60000

General options:
  -h, --help                Show help
  -v, --version             Show version

Examples:
  openocd-tool detect
  openocd-tool flash firmware.hex -t stm32f1x
  openocd-tool flash firmware.bin -t stm32f4x -a 0x08000000
  openocd-tool flash firmware.hex -t stm32f1x -i cmsis-dap
  openocd-tool flash app.elf -t gd32e23x --no-reset
`.trim();

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    firmware: null,
    target: null,
    interface: "stlink",
    transport: "swd",
    speed: 4000,
    address: 0x08000000,
    verify: true,
    reset: true,
    eraseAll: false,
    timeout: 60000,
    json: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case "-h":
      case "--help":
        result.help = true;
        return result;
      case "-v":
      case "--version":
        result.version = true;
        return result;
      case "detect":
      case "flash":
        result.command = arg;
        if (arg === "flash" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
          result.firmware = args[++i];
        }
        break;
      case "-t":
      case "--target":
        result.target = args[++i];
        break;
      case "-i":
      case "--interface":
        result.interface = args[++i];
        break;
      case "-p":
      case "--transport":
        result.transport = args[++i];
        break;
      case "-s":
      case "--speed":
        result.speed = parseInt(args[++i], 10);
        break;
      case "-a":
      case "--address":
        result.address = parseInt(args[++i], 16);
        break;
      case "--no-verify":
        result.verify = false;
        break;
      case "--no-reset":
        result.reset = false;
        break;
      case "--erase-all":
        result.eraseAll = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--timeout":
        result.timeout = parseInt(args[++i], 10);
        break;
      default:
        if (!result.command && !arg.startsWith("-")) {
          console.error(`Unknown command: ${arg}`);
          console.error('Run "openocd-tool --help" for usage');
          process.exit(1);
        } else if (result.command === "flash" && !result.firmware && !arg.startsWith("-")) {
          result.firmware = arg;
        } else {
          console.error(`Unknown option: ${arg}`);
          console.error('Run "openocd-tool --help" for usage');
          process.exit(1);
        }
        break;
    }
    i++;
  }

  return result;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || (!opts.command && !opts.version)) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (opts.version) {
    const pkg = require("../package.json");
    console.log(`openocd-tool v${pkg.version}`);
    process.exit(0);
  }

  if (opts.command === "detect") {
    const devices = await detect();
    if (opts.json) {
      console.log(JSON.stringify(devices, null, 2));
    } else {
      if (devices.length === 0) {
        console.log("No ST-Link or DAPLink devices detected.");
        console.log("\nPlease make sure:");
        console.log("  1. The device is connected via USB");
        console.log("  2. The correct USB driver is installed");
        console.log("     - ST-Link: Install ST-LINK USB Driver (STSW-LINK009)");
        console.log("     - DAPLink: Usually driver-free (WinUSB on Windows)");
      } else {
        console.log(`Found ${devices.length} debug probe(s):\n`);
        devices.forEach((device, index) => {
          console.log(`  [${index + 1}] ${device.type}`);
          console.log(`      Description: ${device.description}`);
          console.log(`      VID:PID = ${device.vid}:${device.pid}`);
          if (device.serial) {
            console.log(`      Serial: ${device.serial}`);
          }
          if (device.targetVoltage) {
            console.log(`      Target voltage: ${device.targetVoltage}`);
          }
          console.log();
        });
      }
    }
    return;
  }

  if (opts.command === "flash") {
    if (!opts.firmware) {
      console.error("Error: Please specify a firmware file path");
      console.error('Usage: openocd-tool flash <firmware> -t <target>');
      process.exit(1);
    }
    if (!opts.target) {
      console.error("Error: Please specify target chip (-t/--target)");
      console.error("e.g. -t stm32f1x, -t stm32f4x, -t gd32e23x");
      process.exit(1);
    }

    console.log(`Flashing ${path.basename(opts.firmware)} to ${opts.target} ...`);

    const result = await flashFirmware({
      firmwarePath: opts.firmware,
      target: opts.target,
      interface: opts.interface,
      transport: opts.transport,
      speed: opts.speed,
      baseAddress: opts.address,
      verify: opts.verify,
      reset: opts.reset,
      eraseAll: opts.eraseAll,
      timeout: opts.timeout,
      onProgress: (text) => {
        // Show OpenOCD progress lines in real-time
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Show important progress lines (Info level from OpenOCD)
          if (/^(Info|Warn|Error)\s*:/i.test(trimmed) ||
              /^\*\*/.test(trimmed) ||
              /wrote\s+\d+/i.test(trimmed) ||
              /verified\s+\d+/i.test(trimmed) ||
              /Programming|Erasing|Verify/i.test(trimmed)) {
            process.stderr.write(`  ${trimmed}\n`);
          }
        }
      },
    });

    if (result.success) {
      console.log("Flash complete!");
      if (opts.verify && result.output && result.output.includes("Verified OK")) {
        console.log("Verification passed.");
      }
    } else {
      console.error("Flash failed!");
      if (result.output) {
        // Extract error and warning lines
        const importantLines = result.output
          .split("\n")
          .filter((l) => /error|fail|unable|warn|cannot|couldn't|not found|timeout|timed out/i.test(l))
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        
        if (importantLines.length > 0) {
          console.error("\nError details:");
          importantLines.forEach((l) => console.error(`  ${l}`));
        }
        
        // Show full OpenOCD output for debugging
        console.error("\nFull output:");
        console.error("-".repeat(60));
        console.error(result.output.trim());
        console.error("-".repeat(60));
      }
    }

    process.exit(result.success ? 0 : 1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
