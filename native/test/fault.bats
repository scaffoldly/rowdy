# The fault report (VFS_FAULT_REPORT=1): a fatal SIGSEGV is described on stderr (signal, address,
# pc and its mapping, the faulting thread's last hook), then the process still dies by the signal.
# By default nothing is installed: no report, no alternate stack on a new thread.

load helpers

setup_file() {
  compile segv -O0 -lpthread
  gcc -shared -fPIC "$BATS_TEST_DIRNAME/c/boom.c" -o "$BATS_FILE_TMPDIR/boom.so"
  mkdir -p /vfs/faults
  echo x >/vfs/faults/one
}

teardown_file() {
  rm -rf /vfs/faults
}

setup() {
  segv="$BATS_FILE_TMPDIR/segv"
}

# fault <command...>: run it with stderr only, as $output and $status
fault() { run --separate-stderr "$@"; output=$stderr; }

@test "off by default: no report, and a new thread gets no alternate stack" {
  fault env -u VFS_FAULT_REPORT "$segv" null
  [ "$status" -eq 139 ]
  [[ "$output" != *"rowdy-vfs:"* ]]
  run env -u VFS_FAULT_REPORT "$segv" altstack
  [ "$status" -eq 0 ]
  run env VFS_FAULT_REPORT=1 "$segv" altstack
  [ "$status" -eq 1 ]
}

@test "VFS_FAULT_REPORT=0 is off" {
  fault env VFS_FAULT_REPORT=0 "$segv" null
  [ "$status" -eq 139 ]
  [[ "$output" != *"rowdy-vfs:"* ]]
}

@test "a NULL dereference: signal, address, shim build, pc's object, registers, code, stack" {
  fault env VFS_FAULT_REPORT=1 "$segv" null
  [ "$status" -eq 139 ]
  [[ "$output" == *"rowdy-vfs: fatal SIGSEGV (signal 11, code 1 SEGV_MAPERR) at 0x0, pid "*", tid "*", shim "* ]]
  [[ "$output" == *"rowdy-vfs: pc 0x"* ]]
  [[ "$output" == *" $segv+0x"* ]]
  [[ "$output" == *"rowdy-vfs: regs "* ]]
  [[ "$output" =~ rowdy-vfs:\ code\ 0x[0-9a-f]+:.*\[[0-9a-f]{2}\] ]]
  [[ "$output" == *"rowdy-vfs: stack sp+0x"* ]]   # main's return address into libc, at least
  [[ "$output" == *"rowdy-vfs: threads 1 registered, 0 others inside a hook or waiting on 9P"* ]]
}

@test "VFS_FAULT_FILE gets the same report, appended across crashes; stderr still gets it" {
  local file="$BATS_TEST_TMPDIR/fault-report"
  fault env VFS_FAULT_REPORT=1 VFS_FAULT_FILE="$file" "$segv" null
  [ "$status" -eq 139 ]
  [[ "$output" == *"rowdy-vfs: fatal SIGSEGV"* ]]
  [ "$(cat "$file")" = "$output" ]
  fault env VFS_FAULT_REPORT=1 VFS_FAULT_FILE="$file" "$segv" ill
  [ "$(grep -c "rowdy-vfs: fatal" "$file")" -eq 2 ]
  grep -q "rowdy-vfs: fatal SIGILL" "$file"
}

@test "other threads inside a hook are listed with their path" {
  fault env VFS_FAULT_REPORT=1 "$segv" busy
  [ "$status" -eq 139 ]
  [[ "$output" == *"not in a hook"* ]]
  [[ "$output" =~ rowdy-vfs:\ thread\ [0-9]+:\ inside\ scandir\(\"/vfs/faults\"\) ]]
  [[ "$output" == *"rowdy-vfs: threads 2 registered, 1 others inside a hook or waiting on 9P"* ]]
}

@test "an illegal instruction is reported as SIGILL" {
  fault env VFS_FAULT_REPORT=1 "$segv" ill
  [ "$status" -eq 132 ]
  [[ "$output" == *"rowdy-vfs: fatal SIGILL (signal 4, code "* ]]
  [[ "$output" == *"rowdy-vfs: code 0x"* ]]
}

@test "a thread that overflowed its stack is reported from its alternate stack" {
  fault env VFS_FAULT_REPORT=1 "$segv" thread
  [ "$status" -eq 139 ]
  [[ "$output" == *"rowdy-vfs: fatal SIGSEGV"* ]]
  [[ "$output" == *"in a guard page: stack overflow"* ]]
}

@test "a fault inside a hook names the hook and its path" {
  fault env VFS_FAULT_REPORT=1 "$segv" hook
  [ "$status" -eq 139 ]
  [[ "$output" == *'inside scandir("/vfs/faults")'* ]]
}

@test "a fault the program's own handler recovers from is not reported" {
  fault env VFS_FAULT_REPORT=1 "$segv" recover
  [ "$status" -eq 0 ]
  [[ "$output" != *"rowdy-vfs:"* ]]
}

@test "node: a fault inside the process is reported, then node's handler runs and it dies by the signal" {
  fault env VFS_FAULT_REPORT=1 node -e "process.dlopen({ exports: {} }, '$BATS_FILE_TMPDIR/boom.so')"
  [ "$status" -eq 139 ]
  [[ "$output" == *"rowdy-vfs: fatal SIGSEGV (signal 11, code 1 SEGV_MAPERR) at 0x0"* ]]
  [[ "$output" == *"/boom.so+0x"* ]]
}

@test "node starts without a report: OpenSSL's SIGILL probe of CPU features is its own to recover" {
  fault env VFS_FAULT_REPORT=1 node -e 0
  [ "$status" -eq 0 ]
  [[ "$output" != *"rowdy-vfs:"* ]]
}

@test "node: a sent SIGSEGV is left to node, unreported" {
  run env -u LD_PRELOAD node -e 'process.kill(process.pid, "SIGSEGV")'
  local plain=$status
  fault env VFS_FAULT_REPORT=1 node -e 'process.kill(process.pid, "SIGSEGV")'
  [ "$status" -eq "$plain" ]
  [[ "$output" != *"rowdy-vfs:"* ]]
}

@test "node: a WebAssembly bounds trap stays a RuntimeError, unreported" {
  fault env VFS_FAULT_REPORT=1 node -e '
const bytes = Uint8Array.from([0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0, 5,3,1,0,1,
  7,5,1,1,102,0,0, 10,11,1,9,0,65,240,162,4,40,2,0,11]);
const { f } = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
try { f(); process.exit(1); } catch (e) { if (!(e instanceof WebAssembly.RuntimeError)) throw e; }'
  [ "$status" -eq 0 ]
  [[ "$output" != *"rowdy-vfs:"* ]]
}
