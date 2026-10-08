import { isStaticElf, programOf } from '../../src/util/elf';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PT_LOAD = 1;
const PT_INTERP = 3;

// A minimal ELF64 little-endian header followed by a program header table of the given types.
const elf64 = (types: number[]): Buffer => {
  const phoff = 64;
  const phentsize = 56;
  const buf = Buffer.alloc(phoff + phentsize * types.length);
  buf.writeUInt32BE(0x7f454c46, 0); // \x7fELF
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(2, 0x10); // ET_EXEC
  buf.writeBigUInt64LE(BigInt(phoff), 0x20);
  buf.writeUInt16LE(phentsize, 0x36);
  buf.writeUInt16LE(types.length, 0x38);
  types.forEach((type, i) => buf.writeUInt32LE(type, phoff + i * phentsize));
  return buf;
};

// The same in ELF32 big-endian, so the reader is not tied to one layout.
const elf32be = (types: number[]): Buffer => {
  const phoff = 52;
  const phentsize = 32;
  const buf = Buffer.alloc(phoff + phentsize * types.length);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 1; // ELFCLASS32
  buf[5] = 2; // ELFDATA2MSB
  buf[6] = 1;
  buf.writeUInt16BE(2, 0x10);
  buf.writeUInt32BE(phoff, 0x1c);
  buf.writeUInt16BE(phentsize, 0x2a);
  buf.writeUInt16BE(types.length, 0x2c);
  types.forEach((type, i) => buf.writeUInt32BE(type, phoff + i * phentsize));
  return buf;
};

describe('isStaticElf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rowdy-elf-'));
  const file = (name: string, content: Buffer | string): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('is true for an executable with no program interpreter', () => {
    expect(isStaticElf(file('static', elf64([PT_LOAD, PT_LOAD])))).toBe(true);
  });

  it('is false for a dynamically linked executable (PT_INTERP)', () => {
    expect(isStaticElf(file('dynamic', elf64([PT_LOAD, PT_INTERP, PT_LOAD])))).toBe(false);
  });

  it('reads 32-bit big-endian headers too', () => {
    expect(isStaticElf(file('static32', elf32be([PT_LOAD])))).toBe(true);
    expect(isStaticElf(file('dynamic32', elf32be([PT_INTERP, PT_LOAD])))).toBe(false);
  });

  it('is undefined for anything that is not a readable ELF', () => {
    expect(isStaticElf(file('script', '#!/bin/sh\necho hi\n'))).toBeUndefined();
    expect(isStaticElf(file('short', Buffer.from([0x7f, 0x45, 0x4c, 0x46])))).toBeUndefined();
    expect(isStaticElf(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('programOf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rowdy-prog-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const exe = (name: string, content: Buffer | string): string => {
    const path = join(bin, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
    return path;
  };
  const server = exe('server', elf64([PT_LOAD]));
  const node = exe('node', elf64([PT_INTERP, PT_LOAD]));
  const env = exe('env', elf64([PT_INTERP, PT_LOAD]));
  const PATH = `${join(dir, 'empty')}:${bin}`;

  it('is a path as given', () => {
    expect(programOf(server, PATH)).toBe(server);
  });

  it('finds a bare name on PATH', () => {
    expect(programOf('server', PATH)).toBe(server);
    expect(programOf('nothing-here', PATH)).toBeUndefined();
  });

  it("follows a script's #! line to its interpreter, through env", () => {
    expect(programOf(exe('direct.js', `#!${node}\nconsole.log(1)\n`), PATH)).toBe(node);
    expect(programOf(exe('via-env.js', `#!${env} node\nconsole.log(1)\n`), PATH)).toBe(node);
    expect(programOf(exe('env-flags.js', `#!${env} -S node --no-warnings\n`), PATH)).toBe(node);
  });
});
