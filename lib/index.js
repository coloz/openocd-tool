const { execFile, exec } = require("child_process");
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
 * 执行 openocd 命令并返回 stdout + stderr 输出
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
 * 通过系统 USB 枚举获取 ST-Link 设备的序列号
 * Windows 下使用 PowerShell Get-PnpDevice，Linux 下读取 /sys/bus/usb
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
            // USB\VID_0483&PID_374B\005300194A00001156313848
            const m = line.match(/USB\\VID_([0-9a-fA-F]{4})&PID_([0-9a-fA-F]{4})\\([^\s]+)/);
            if (m) {
              serials.push({ vid: m[1], pid: m[2], serial: m[3].trim() });
            }
          }
          resolve(serials);
        }
      );
    } else {
      // Linux: 遍历 /sys/bus/usb/devices 查找 ST-Link 设备
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
 * 检测已连接的 ST-Link 设备
 * 通过 openocd 的 stlink 接口配置，解析日志中的设备信息
 */
async function detectStlink() {
  const devices = [];

  // 先尝试 stlink.cfg + swd，失败则回退到 stlink-dap.cfg
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

  // 典型输出: "Info : STLINK V2J14S0 (API v2) VID:PID 0483:3748"
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

  // 通过系统 USB 枚举获取序列号
  const usbSerials = await getStlinkSerials();

  const voltageMatch = output.match(
    /Info\s*:\s*Target voltage:\s*([\d.]+)/i
  );
  for (const dev of devices) {
    // 匹配 VID:PID 找到对应的 USB 序列号
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
 * 检测已连接的 DAPLink (CMSIS-DAP) 设备
 * 通过 openocd 的 cmsis-dap 接口配置，解析日志中的设备信息
 */
async function detectDaplink() {
  const devices = [];

  // 使用 -d3 debug 级别以获取 VID:PID 信息
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

  // 检查是否完全没有发现设备
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
 * 烧录固件到 STM32/GD32 芯片
 *
 * @param {Object} options - 烧录选项
 * @param {string} options.firmwarePath - 固件文件路径（支持 .hex / .bin / .elf）
 * @param {string} options.target - 目标芯片配置，如 "stm32f1x", "stm32f4x", "gd32e23x" 等
 * @param {string} [options.interface] - 调试器接口，"stlink" 或 "cmsis-dap"，默认 "stlink"
 * @param {string} [options.transport] - 传输协议，默认 "swd"
 * @param {number} [options.speed] - 适配器速度(kHz)，默认 4000
 * @param {number} [options.baseAddress] - .bin 文件的基地址，默认 0x08000000
 * @param {boolean} [options.verify] - 烧录后是否校验，默认 true
 * @param {boolean} [options.reset] - 烧录后是否复位运行，默认 true
 * @param {boolean} [options.eraseAll] - 是否全片擦除（否则仅擦除所需扇区），默认 false
 * @param {number} [options.timeout] - 超时时间(ms)，默认 60000
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
  } = options;

  // 校验固件文件存在
  const resolvedPath = path.resolve(firmwarePath);
  if (!fs.existsSync(resolvedPath)) {
    return { success: false, output: `固件文件不存在: ${resolvedPath}` };
  }

  // 校验文件扩展名
  const ext = path.extname(resolvedPath).toLowerCase();
  if (![".hex", ".bin", ".elf"].includes(ext)) {
    return {
      success: false,
      output: `不支持的固件格式: ${ext}，仅支持 .hex / .bin / .elf`,
    };
  }

  // 构建接口配置
  let interfaceFile;
  let transportCmd;
  if (iface === "cmsis-dap") {
    interfaceFile = "interface/cmsis-dap.cfg";
    transportCmd = transport === "jtag" ? "jtag" : "swd";
  } else {
    interfaceFile = "interface/stlink.cfg";
    transportCmd = transport === "jtag" ? "hla_jtag" : "hla_swd";
  }

  // 构建目标配置文件名
  const targetFile = `target/${target}.cfg`;

  // 构建烧录命令 - 使用正斜杠以兼容 OpenOCD
  const firmwarePathForOcd = resolvedPath.replace(/\\/g, "/");
  const flashCommands = [];

  if (eraseAll) {
    flashCommands.push("flash erase_sector 0 0 last");
  }

  // 根据文件格式选择烧录命令
  if (ext === ".hex" || ext === ".elf") {
    flashCommands.push(`program {${firmwarePathForOcd}}${verify ? " verify" : ""}${reset ? " reset" : ""}`);
  } else {
    // .bin 文件需要指定基地址
    const addr = `0x${baseAddress.toString(16).padStart(8, "0")}`;
    flashCommands.push(`program {${firmwarePathForOcd}} ${addr}${verify ? " verify" : ""}${reset ? " reset" : ""}`);
  }

  // 组装 openocd 参数
  const args = [
    "-f", interfaceFile,
    "-c", `transport select ${transportCmd}`,
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

  const output = await runOpenocd(args, timeout);

  // 判断烧录是否成功
  const success =
    output.includes("Verified OK") ||
    output.includes("** Programming Finished **") ||
    (output.includes("wrote") && !output.includes("Error"));

  return { success, output };
}

/**
 * 检测所有已连接的调试器设备（ST-Link + DAPLink）
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
 * 缩写序列号，便于 UI 显示
 * @param {string} serial - 完整序列号
 * @param {number} [keep=8] - 保留的末尾字符数
 * @returns {string} 缩写后的序列号，如 "...13848" 或原样返回（短序列号）
 */
function shortSerial(serial, keep = 8) {
  if (!serial || serial.length <= keep) return serial || "";
  return "..." + serial.slice(-keep);
}

module.exports = { detect, detectStlink, detectDaplink, flashFirmware, shortSerial };
