import { badRequest } from '../../http/errors'
import { str } from '../../http/validate'
import { deleteClient, listClients, patchClient, runCommand } from '../../services/clients'
import { createEnrollment } from '../../services/enrollments'
import { ACTION, choice, inWorkspace, integer, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Tool } from '../tool'
import { DEVICE_SETTINGS } from './schemas'

const DEVICE_ID = text('Device id, from list_devices')
const deviceIdOf = (args: Record<string, unknown>) => str(args, 'deviceId', { max: 64 })
const COMMANDS = ['discover', 'refresh', 'identify', 'logs', 'diagnose', 'restart', 'update'] as const

const PI_STEPS =
  'Raspberry Pi: flash Raspberry Pi OS Lite with Raspberry Pi Imager. Easiest: in the Print Better web app add a device, choose Raspberry Pi, ' +
  'and copy the generated first-boot files to the SD card (Wi-Fi details stay in the browser). Or boot the Pi and run the raspberryPi command over SSH.'

export const deviceTools: Tool[] = [
  {
    name: 'list_devices',
    title: 'List devices',
    description: 'Paired computers and Raspberry Pis that connect printers to Print Better, with online state and settings.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const devices = await listClients(ctx, await workspaceOf(ctx, args))
      return output(`${devices.length} device(s), ${devices.filter((d) => d.online).length} online.`, { devices })
    },
  },
  {
    name: 'update_device',
    title: 'Update device',
    description: "Renames a device or changes its settings: tray icon, LAN sharing, auto-add rule, discovery sources, pause, log level, showing other devices' printers on this computer. Admins and owners only.",
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ deviceId: DEVICE_ID, name: text('New name'), settings: DEVICE_SETTINGS }, ['deviceId']),
    run: async (ctx, args) => {
      const device = await patchClient(ctx, await workspaceOf(ctx, args), deviceIdOf(args), pick(args, ['name', 'settings']))
      return output(`Updated ${device.name}${device.online ? '' : '; it applies the change when it comes online'}.`, { device })
    },
  },
  {
    name: 'remove_device',
    title: 'Remove device',
    description: 'Unpairs a device: revokes its access, tells it to unpair if online, and removes its printers. Admins and owners only.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ deviceId: DEVICE_ID }, ['deviceId']),
    run: async (ctx, args) => {
      const id = deviceIdOf(args)
      await deleteClient(ctx, await workspaceOf(ctx, args), id)
      return output(`Removed device ${id} and its printers.`, { removed: id })
    },
  },
  {
    name: 'create_device_install',
    title: 'Add a device',
    description: 'Mints a single-use install code and returns copy-paste commands for macOS/Linux and Windows, plus Raspberry Pi first-boot steps. Admins and owners only.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace({
      label: text('Note to recognize the code later, e.g. "Office Pi"'),
      maxUses: integer('How many devices may use the code (default 1)', 1, 1000),
      ttlHours: integer('Hours until the code expires (default 24)', 1, 720),
    }),
    run: async (ctx, args) => {
      const e = await createEnrollment(ctx, await workspaceOf(ctx, args), pick(args, ['label', 'maxUses', 'ttlHours']))
      const raspberryPi = `curl -fsSL ${e.server}/install.sh | sh -s -- --token ${e.token} --system --no-tray --name <hostname>`
      const commands = { macosLinux: e.commands.unix, windows: e.commands.windows, raspberryPi }
      const summary = `Install code ready until ${new Date(e.expiresAt).toISOString()}.\nmacOS/Linux: ${commands.macosLinux}\nWindows (PowerShell): ${commands.windows}\n${PI_STEPS}`
      return output(summary, { expiresAt: e.expiresAt, server: e.server, commands, raspberryPiSteps: PI_STEPS })
    },
  },
  {
    name: 'device_command',
    title: 'Run device command',
    description:
      'Runs a command on an online device and waits up to 20 s: discover (search for printers), refresh (re-read printer status), identify, logs, diagnose (connectivity checks), restart, update (install the latest published release, then restart). Admins and owners only.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace(
      { deviceId: DEVICE_ID, name: choice('Command', COMMANDS), args: { type: 'object', description: 'Command arguments, if any' } },
      ['deviceId', 'name'],
    ),
    run: async (ctx, args) => {
      const result = await runCommand(ctx, await workspaceOf(ctx, args), deviceIdOf(args), pick(args, ['name', 'args']))
      if (!result.ok) throw badRequest(`The device could not run ${String(args.name)}: ${result.error ?? 'unknown error'}`, 'command_failed')
      return output(`${String(args.name)} finished.`, { result: result.data ?? null })
    },
  },
]
