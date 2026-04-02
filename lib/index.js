const { execFile, exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const OPENOCD_VERSION = "0.12.0-7";

// openocd 路径自适应平台
const isWin = process.platform === "win32";
const VENDOR_DIR = path.join(
  __dirname,
  "..",
  "vendor",
  `xpack-openocd-${OPENOCD_VERSION}`
);
const OPENOCD_BIN = path.join(
  VENDOR_DIR,
  "bin",
  isWin ? "openocd.exe" : "openocd"
);

// openocd 脚本目录
const SCRIPTS_DIR = path.join(VENDOR_DIR, "openocd", "scripts");

/**
 * Run openocd command and return stdout + stderr output
 */
function runOpenocd(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(
      OPENOCD_BIN,
      ["-s", SCRIPTS_DIR, ...args],
      { timeout: timeoutMs, windowsHide: true },
      (_error, stdout, stderr) => {
        resolve((stdout || "") + (stderr || ""));
      }
    );
  });
}

/**
 * Run openocd command with real-time progress output via onData callback
 */
function runOpenocdWithProgress(args, timeoutMs = 60000, onData = null) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(OPENOCD_BIN, ["-s", SCRIPTS_DIR, ...args], {
      windowsHide: true,
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        output += "\nProcess timed out.";
      }, timeoutMs);
    }

    const handleData = (data) => {
      const text = data.toString();
      output += text;
      if (onData) onData(text);
    };

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);

    child.on("close", () => {
      if (timer) clearTimeout(timer);
      resolve(output);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      output += `\n${err.message}`;
      resolve(output);
    });
  });
}

/**
 * Get ST-Link device serial numbers via system USB enumeration
 */
function getStlinkSerials() {
  return new Promise((resolve) => {
    if (isWin) {
      const psCmd = `Get-PnpDevice | Where-Object { $_.InstanceId -match '^USB\\\\VID_0483' -and $_.InstanceId -notmatch 'MI_' } | Select-Object -ExpandProperty InstanceId`;
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", psCmd],
        { timeout: 5000, windowsHide: true },
        (_err, stdout) => {
          const serials = [];
          const lines = (stdout || "").split("\n");
          for (const line of lines) {
            // e.g. USB\VID_0483&PID_374B\005300194A00001156313848
            const m = line.match(/USB\\VID_([0-9a-fA-F]{4})&PID_([0-9a-fA-F]{4})\\([^\s]+)/);
            if (m) {
              serials.push({ vid: m[1], pid: m[2], serial: m[3].trim() });
            }
          }
          resolve(serials);
        }
      );
    } else {
      // Linux: enumerate /sys/bus/usb/devices for ST-Link devices
      exec(
        'grep -rl "0483" /sys/bus/usb/devices/*/idVendor 2>/dev/null | while read f; do d=$(dirname "$f"); vid=$(cat "$d/idVendor"); pid=$(cat "$d/idProduct"); serial=$(cat "$d/serial" 2>/dev/null || echo ""); echo "$vid:$pid:$serial"; done',
        { timeout: 5000 },
        (_err, stdout) => {
          const serials = [];
          const lines = (stdout || "").split("\n");
          for (const line of lines) {
            const parts = line.trim().split(":");
            if (parts.length >= 3 && parts[0] === "0483") {
              serials.push({ vid: parts[0], pid: parts[1], serial: parts.slice(2).join(":") });
            }
          }
          resolve(serials);
        }
      );
    }
  });
}

/**
 * Detect connected ST-Link devices via OpenOCD stlink interface
 */
async function detectStlink() {
  const devices = [];

  // Try stlink.cfg + swd first, fall back to stlink-dap.cfg
  let output = await runOpenocd([
    "-f",
    "interface/stlink.cfg",
    "-c",
    "transport select swd",
    "-c",
    "adapter speed 1000",
    "-c",
    "set _CHIPNAME dummy",
    "-c",
    "swd newdap $_CHIPNAME cpu -irlen 4",
    "-c",
    "init",
    "-c",
    "shutdown",
  ]);

  if (
    output.includes("doesn't support") ||
    output.includes("No ST-LINK") ||
    output.includes("unable to open")
  ) {
    output = await runOpenocd([
      "-f",
      "interface/stlink-dap.cfg",
      "-c",
      "transport select dapdirect_swd",
      "-c",
      "adapter speed 1000",
      "-c",
      "set _CHIPNAME dummy",
      "-c",
      "swd newdap $_CHIPNAME cpu -irlen 4",
      "-c",
      "init",
      "-c",
      "shutdown",
    ]);
  }

  // Typical output: "Info : STLINK V2J14S0 (API v2) VID:PID 0483:3748"
  const stlinkPattern =
    /Info\s*:\s*(STLINK\s+\S+[^\n]*?)(?:\s+VID:PID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4}))?(?:\r?\n|$)/gi;
  let match;
  while ((match = stlinkPattern.exec(output)) !== null) {
    const desc = match[1].trim();
    if (desc.includes("Unable") || desc.includes("Error")) continue;
    devices.push({
      type: "ST-Link",
      description: desc,
      vid: match[2] || "0483",
      pid: match[3] || "unknown",
    });
  }

  // Get serial numbers via system USB enumeration
  const usbSerials = await getStlinkSerials();

  const voltageMatch = output.match(
    /Info\s*:\s*Target voltage:\s*([\d.]+)/i
  );
  for (const dev of devices) {
    // Match VID:PID to find corresponding USB serial number
    const usbInfo = usbSerials.find(
      (u) => u.vid.toLowerCase() === dev.vid.toLowerCase() &&
             u.pid.toLowerCase() === dev.pid.toLowerCase()
    );
    if (usbInfo && usbInfo.serial) dev.serial = usbInfo.serial;
    if (voltageMatch) dev.targetVoltage = `${voltageMatch[1]}V`;
  }

  return devices;
}

/**
 * Detect connected DAPLink (CMSIS-DAP) devices via OpenOCD cmsis-dap interface
 */
async function detectDaplink() {
  const devices = [];

  // Use -d3 debug level to capture VID:PID info
  const output = await runOpenocd([
    "-d3",
    "-f",
    "interface/cmsis-dap.cfg",
    "-c",
    "transport select swd",
    "-c",
    "adapter speed 1000",
    "-c",
    "set _CHIPNAME dummy",
    "-c",
    "swd newdap $_CHIPNAME cpu -irlen 4",
    "-c",
    "init",
    "-c",
    "shutdown",
  ]);

  // Check if no device was found at all
  if (
    output.includes("no CMSIS-DAP device found") ||
    (output.includes("unable to open") && !output.includes("CMSIS-DAP: FW"))
  ) {
    return devices;
  }

  const lines = output.split("\n");
  let vid = "unknown";
  let pid = "unknown";
  let serial = undefined;
  let fwVersion = undefined;
  let productName = undefined;
  let found = false;

  for (const line of lines) {
    // Debug: "found product string of 0x0d28:0x0204 'DAPLink CMSIS-DAP'"
    const productMatch = line.match(
      /found product string of 0x([0-9a-fA-F]+):0x([0-9a-fA-F]+)\s+'([^']+)'/i
    );
    if (productMatch) {
      vid = productMatch[1];
      pid = productMatch[2];
      productName = productMatch[3];
      found = true;
      continue;
    }

    // "Using CMSIS-DAPv2 interface with VID:PID=0x0d28:0x0204, serial=..."
    const usingMatch = line.match(
      /Using\s+(CMSIS-DAPv?\d?)\s+interface\s+with\s+VID:PID=0x([0-9a-fA-F]+):0x([0-9a-fA-F]+)(?:,\s*serial=(\S+))?/i
    );
    if (usingMatch) {
      vid = usingMatch[2];
      pid = usingMatch[3];
      if (usingMatch[4]) serial = usingMatch[4];
      found = true;
      continue;
    }

    // "CMSIS-DAP: FW Version = 2.1.0"
    const fwMatch = line.match(/CMSIS-DAP:\s*FW\s*Version\s*=\s*(\S+)/i);
    if (fwMatch) {
      fwVersion = fwMatch[1];
      found = true;
      continue;
    }

    // "CMSIS-DAP: Serial# = ..."
    const serialMatch = line.match(/CMSIS-DAP:\s*Serial#\s*=\s*(\S+)/i);
    if (serialMatch) {
      serial = serialMatch[1];
      found = true;
      continue;
    }

    // "CMSIS-DAP: Interface Initialised (SWD)" / "Interface ready"
    if (/CMSIS-DAP:\s*Interface\s+(Initialised|ready)/i.test(line)) {
      found = true;
    }
  }

  if (found) {
    const descParts = [];
    if (productName) descParts.push(productName);
    if (fwVersion) descParts.push(`FW ${fwVersion}`);

    devices.push({
      type: "DAPLink (CMSIS-DAP)",
      description:
        descParts.length > 0
          ? descParts.join(", ")
          : "CMSIS-DAP device detected",
      vid,
      pid,
      serial,
    });
  }

  return devices;
}

/**
 * Flash firmware to STM32/GD32 chip
 *
 * @param {Object} options
 * @param {string} options.firmwarePath - Firmware file path (.hex / .bin / .elf)
 * @param {string} options.target - Target chip config, e.g. "stm32f1x", "stm32f4x", "gd32e23x"
 * @param {string} [options.interface] - Debug interface: "stlink" or "cmsis-dap", default "stlink"
 * @param {string} [options.transport] - Transport protocol, default "swd"
 * @param {number} [options.speed] - Adapter speed (kHz), default 4000
 * @param {number} [options.baseAddress] - Base address for .bin files, default 0x08000000
 * @param {boolean} [options.verify] - Verify after programming, default true
 * @param {boolean} [options.reset] - Reset after programming, default true
 * @param {boolean} [options.eraseAll] - Full chip erase, default false
 * @param {number} [options.timeout] - Timeout (ms), default 60000
 * @param {function} [options.onProgress] - Callback for real-time output: onProgress(text)
 * @returns {Promise<{success: boolean, output: string}>}
 */
async function flashFirmware(options) {
  const {
    firmwarePath,
    target,
    interface: iface = "stlink",
    transport = "swd",
    speed = 4000,
    baseAddress = 0x08000000,
    verify = true,
    reset = true,
    eraseAll = false,
    timeout = 60000,
    onProgress = null,
  } = options;

  // Validate firmware file exists
  const resolvedPath = path.resolve(firmwarePath);
  if (!fs.existsSync(resolvedPath)) {
    return { success: false, output: `Firmware file not found: ${resolvedPath}` };
  }

  // Validate file extension
  const ext = path.extname(resolvedPath).toLowerCase();
  if (![".hex", ".bin", ".elf"].includes(ext)) {
    return {
      success: false,
      output: `Unsupported firmware format: ${ext}, only .hex / .bin / .elf are supported`,
    };
  }

  // Build target config filename
  const targetFile = `target/${target}.cfg`;

  // Build flash commands - use forward slashes for OpenOCD compatibility
  const firmwarePathForOcd = resolvedPath.replace(/\\/g, "/");
  const flashCommands = [];

  if (eraseAll) {
    flashCommands.push("flash erase_sector 0 0 last");
  }

  // Choose flash command based on file format
  if (ext === ".hex" || ext === ".elf") {
    flashCommands.push(`program {${firmwarePathForOcd}}${verify ? " verify" : ""}${reset ? " reset" : ""}`);
  } else {
    // .bin files require a base address
    const addr = `0x${baseAddress.toString(16).padStart(8, "0")}`;
    flashCommands.push(`program {${firmwarePathForOcd}} ${addr}${verify ? " verify" : ""}${reset ? " reset" : ""}`);
  }

  // Define interface configs in priority order
  // ST-Link V2 uses stlink.cfg + hla_swd
  // ST-Link V3 and some clones use stlink-dap.cfg + dapdirect_swd
  let interfaceConfigs;
  if (iface === "cmsis-dap") {
    interfaceConfigs = [
      { file: "interface/cmsis-dap.cfg", transport: transport === "jtag" ? "jtag" : "swd" }
    ];
  } else {
    // ST-Link: try hla_swd first, fall back to dapdirect_swd
    interfaceConfigs = [
      { file: "interface/stlink.cfg", transport: transport === "jtag" ? "hla_jtag" : "hla_swd" },
      { file: "interface/stlink-dap.cfg", transport: transport === "jtag" ? "dapdirect_jtag" : "dapdirect_swd" }
    ];
  }

  let output = "";
  let success = false;

  for (const config of interfaceConfigs) {
    // Assemble openocd arguments
    const args = [
      "-f", config.file,
      "-c", `transport select ${config.transport}`,
      "-c", `adapter speed ${speed}`,
      "-f", targetFile,
      "-c", "init",
    ];

    for (const cmd of flashCommands) {
      args.push("-c", cmd);
    }

    if (!reset) {
      args.push("-c", "shutdown");
    } else {
      args.push("-c", "reset run", "-c", "shutdown");
    }

    // Use spawn with real-time progress if onProgress callback is provided
    if (onProgress) {
      output = await runOpenocdWithProgress(args, timeout, onProgress);
    } else {
      output = await runOpenocd(args, timeout);
    }

    // Check if we need to fall back to another transport
    if (output.includes("doesn't support") && interfaceConfigs.length > 1) {
      continue;
    }

    // Determine if flashing was successful
    success =
      output.includes("Verified OK") ||
      output.includes("** Programming Finished **") ||
      (output.includes("wrote") && !output.includes("Error"));

    break;
  }

  return { success, output };
}

/**
 * Detect all connected debug adapters (ST-Link + DAPLink)
 * @returns {Promise<Array<{type: string, description: string, vid: string, pid: string, serial?: string, targetVoltage?: string}>>}
 */
async function detect() {
  const [stlinkDevices, daplinkDevices] = await Promise.all([
    detectStlink(),
    detectDaplink(),
  ]);

  const allDevices = [...stlinkDevices, ...daplinkDevices];
  for (const dev of allDevices) {
    if (dev.serial) {
      dev.shortSerial = dev.type === "ST-Link"
        ? dev.serial.slice(0, 10)
        : dev.serial.slice(-10);
    }
  }

  return allDevices;
}

/**
 * Abbreviate serial number for UI display
 * @param {string} serial - Full serial number
 * @param {number} [keep=8] - Number of trailing characters to keep
 * @returns {string} Abbreviated serial, e.g. "...13848", or original if short
 */
function shortSerial(serial, keep = 8) {
  if (!serial || serial.length <= keep) return serial || "";
  return "..." + serial.slice(-keep);
}

module.exports = { detect, detectStlink, detectDaplink, flashFirmware, shortSerial };
