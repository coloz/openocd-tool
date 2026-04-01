# openocd-tool

STM32/GD32 调试器检测与固件烧录 CLI 工具，基于 [OpenOCD](https://openocd.org/) 实现。

支持 **ST-Link** 和 **DAPLink (CMSIS-DAP)** 调试器，可自动检测设备并烧录固件。

安装时会自动下载当前平台对应的 OpenOCD 二进制文件，无需手动配置。

## 支持平台

- Windows x64
- Linux x64 / arm64
- macOS x64 / arm64 (Apple Silicon)

## 安装

```bash
# 全局安装（推荐，可直接使用 openocd-tool 命令）
npm install -g openocd-tool

# 或作为项目依赖
npm install openocd-tool
```

安装过程中会自动从 GitHub 下载对应平台的 OpenOCD 预编译包。

## 使用

### 检测调试器

扫描已连接的 ST-Link 和 DAPLink 设备：

```bash
openocd-tool detect
```

以 JSON 格式输出：

```bash
openocd-tool detect --json
```

或直接运行：

```bash
node cli.js detect
```

输出示例：

```
正在检测已连接的调试器设备...

共检测到 1 个调试器设备：

  [1] ST-Link
      描述: STLINK V2J14S0 (API v2)
      VID:PID = 0483:3748
      序列号: 066FFF535752877167253530
      目标电压: 3.24V
```

### 烧录固件

```bash
openocd-tool flash <固件文件> -t <目标芯片> [选项]
```

#### 基本用法

```bash
# 烧录 HEX 文件到 STM32F103
openocd-tool flash firmware.hex -t stm32f1x

# 烧录 BIN 文件到 STM32F407（需指定基地址）
openocd-tool flash firmware.bin -t stm32f4x -a 0x08000000

# 烧录 ELF 文件到 GD32E230
openocd-tool flash app.elf -t gd32e23x
```

#### 使用 DAPLink 调试器

```bash
openocd-tool flash firmware.hex -t stm32f1x -i cmsis-dap
```

#### 更多选项

```bash
# 全片擦除后烧录
openocd-tool flash firmware.hex -t stm32f1x --erase-all

# 烧录后不复位
openocd-tool flash firmware.hex -t stm32f1x --no-reset

# 跳过校验
openocd-tool flash firmware.hex -t stm32f1x --no-verify

# 使用 JTAG 传输协议，调整速度
openocd-tool flash firmware.hex -t stm32f1x -p jtag -s 1000
```

### 完整参数列表

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-t, --target <name>` | 目标芯片配置（必须） | - |
| `-i, --interface <type>` | 调试器接口：`stlink` 或 `cmsis-dap` | `stlink` |
| `-p, --transport <type>` | 传输协议：`swd` 或 `jtag` | `swd` |
| `-s, --speed <kHz>` | 适配器速度 | `4000` |
| `-a, --address <hex>` | `.bin` 文件基地址 | `0x08000000` |
| `--no-verify` | 烧录后不校验 | - |
| `--no-reset` | 烧录后不复位 | - |
| `--json` | 以 JSON 格式输出检测结果（仅 detect） | - |
| `--erase-all` | 全片擦除 | - |
| `--timeout <ms>` | 超时时间 | `60000` |
| `-h, --help` | 显示帮助 | - |
| `-v, --version` | 显示版本 | - |

### 支持的目标芯片

**STM32 系列：**
`stm32f0x` `stm32f1x` `stm32f2x` `stm32f3x` `stm32f4x` `stm32f7x`
`stm32g0x` `stm32g4x` `stm32h7x` `stm32l0` `stm32l1` `stm32l4x` `stm32l5x`
`stm32u0x` `stm32u5x` `stm32c0x` `stm32wbx` `stm32wlx`

**GD32 系列：**
`gd32e23x` `gd32vf103`

## 编程接口

也可以作为 Node.js 模块使用：

```js
const { detectAllDevices, flashFirmware } = require("openocd-tool");

// 检测设备
const devices = await detectAllDevices();

// 烧录固件
const result = await flashFirmware({
  firmwarePath: "./firmware.hex",
  target: "stm32f1x",
  interface: "stlink",   // 可选，默认 stlink
  verify: true,           // 可选，默认 true
  reset: true,            // 可选，默认 true
});

console.log(result.success); // true / false
console.log(result.output);  // OpenOCD 输出
```

## 常见问题

**设备未检测到？**
- 确认设备已通过 USB 连接
- ST-Link：需安装 [ST-LINK USB Driver](https://www.st.com/en/development-tools/stsw-link009.html)
- DAPLink：Windows 通常免驱动

**烧录失败？**
- 检查 `-t` 参数是否与芯片型号匹配
- 确认固件文件路径正确
- `.bin` 文件需通过 `-a` 指定正确的基地址

## License

ISC
