#!/usr/bin/env node
"use strict";

const { detectAllDevices, detectStlink, detectDaplink, flashFirmware } = require("./index");

const HELP_TEXT = `
openocd-tool - STM32/GD32 调试器检测与固件烧录工具

用法:
  openocd-tool <command> [options]

命令:
  detect                检测已连接的调试器设备 (ST-Link / DAPLink)
  flash <firmware>      烧录固件到目标芯片

检测选项:
      --json                以 JSON 格式输出检测结果

烧录选项:
  -t, --target <name>       目标芯片 (必须), 如 stm32f1x, stm32f4x, gd32e23x
  -i, --interface <type>    调试器接口: stlink (默认) 或 cmsis-dap
  -p, --transport <type>    传输协议: swd (默认) 或 jtag
  -s, --speed <kHz>         适配器速度, 默认 4000
  -a, --address <hex>       .bin 文件基地址, 默认 0x08000000
      --no-verify           烧录后不校验
      --no-reset            烧录后不复位
      --erase-all           全片擦除
      --timeout <ms>        超时时间, 默认 60000

通用选项:
  -h, --help                显示帮助信息
  -v, --version             显示版本号

示例:
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
        // 如果还没有 command，可能是直接传了固件路径
        if (!result.command && !arg.startsWith("-")) {
          console.error(`未知命令: ${arg}`);
          console.error('使用 "openocd-tool --help" 查看帮助');
          process.exit(1);
        } else if (result.command === "flash" && !result.firmware && !arg.startsWith("-")) {
          result.firmware = arg;
        } else {
          console.error(`未知选项: ${arg}`);
          console.error('使用 "openocd-tool --help" 查看帮助');
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
    const pkg = require("./package.json");
    console.log(`openocd-tool v${pkg.version}`);
    process.exit(0);
  }

  if (opts.command === "detect") {
    if (opts.json) {
      const [stlinkDevices, daplinkDevices] = await Promise.all([
        detectStlink(),
        detectDaplink(),
      ]);
      const allDevices = [...stlinkDevices, ...daplinkDevices];
      console.log(JSON.stringify(allDevices, null, 2));
    } else {
      await detectAllDevices();
    }
    return;
  }

  if (opts.command === "flash") {
    if (!opts.firmware) {
      console.error("错误: 请指定固件文件路径");
      console.error('用法: openocd-tool flash <firmware> -t <target>');
      process.exit(1);
    }
    if (!opts.target) {
      console.error("错误: 请指定目标芯片 (-t/--target)");
      console.error("例如: -t stm32f1x, -t stm32f4x, -t gd32e23x");
      process.exit(1);
    }

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
    });

    if (!result.success && result.output) {
      console.error(result.output);
    }

    process.exit(result.success ? 0 : 1);
  }
}

main().catch((err) => {
  console.error("执行出错:", err.message);
  process.exit(1);
});
