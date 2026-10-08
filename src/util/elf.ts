import { closeSync, openSync, readSync, statSync } from 'fs';
import { basename, join } from 'path';

const PT_INTERP = 3;
const ELF_MAGIC = 0x7f454c46;

const read = (path: string, length: number, position = 0): Buffer | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, position);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/**
 * Whether the ELF executable at `path` has no program interpreter (PT_INTERP): statically linked,
 * so the dynamic loader, and with it LD_PRELOAD, never runs. Undefined when it is not a readable ELF.
 */
export const isStaticElf = (path: string): boolean | undefined => {
  const head = read(path, 64);
  if (!head || head.length < 52 || head.readUInt32BE(0) !== ELF_MAGIC) {
    return undefined;
  }
  const is64 = head[4] === 2;
  const le = head[5] === 1;
  if (is64 && head.length < 64) {
    return undefined;
  }
  const u16 = (b: Buffer, o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b: Buffer, o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const phoff = is64 ? Number(le ? head.readBigUInt64LE(0x20) : head.readBigUInt64BE(0x20)) : u32(head, 0x1c);
  const phentsize = u16(head, is64 ? 0x36 : 0x2a);
  const phnum = u16(head, is64 ? 0x38 : 0x2c);
  if (!phnum || phentsize < (is64 ? 56 : 32)) {
    return undefined;
  }
  const table = read(path, phentsize * phnum, phoff);
  if (!table || table.length < phentsize * phnum) {
    return undefined;
  }
  for (let i = 0; i < phnum; i++) {
    if (u32(table, i * phentsize) === PT_INTERP) {
      return false;
    }
  }
  return true;
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The file that running `command` executes: the path as given, or the first match on PATH; for a
 * script, its #! interpreter instead (through env). Undefined when it cannot be found.
 */
export const programOf = (command: string, PATH = process.env.PATH ?? '', depth = 0): string | undefined => {
  const found = command.includes('/')
    ? isFile(command)
      ? command
      : undefined
    : PATH.split(':')
        .filter((dir) => dir.startsWith('/'))
        .map((dir) => join(dir, command))
        .find(isFile);
  if (!found || depth >= 4) {
    return found;
  }
  const head = read(found, 256);
  if (!head || head[0] !== 0x23 || head[1] !== 0x21) {
    return found; // not a #! script
  }
  const [interpreter, ...args] = (head.toString('latin1', 2).split('\n')[0] ?? '').trim().split(/\s+/);
  if (!interpreter) {
    return found;
  }
  if (basename(interpreter) === 'env') {
    const target = args.find((arg) => !arg.startsWith('-'));
    return target ? programOf(target, PATH, depth + 1) : found;
  }
  return programOf(interpreter, PATH, depth + 1);
};
