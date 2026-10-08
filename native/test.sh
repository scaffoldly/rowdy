#!/bin/sh
# Integration test for the shim built by native/build.sh. Drives it through the image's own shell
# and coreutils (busybox on alpine, GNU on debian), node (libuv), C callers, several mounts and the
# package's 9P server, under LD_PRELOAD.
#
#   sh native/test.sh x64|arm64 alpine|debian
set -eu

if [ -z "${VFS_STAGE:-}" ]; then
  if [ ! -f /.dockerenv ]; then
    arch="${1:-}"; flavour="${2:-}"
    case "$arch" in
      x64)   platform=linux/amd64 ;;
      arm64) platform=linux/arm64 ;;
      *) echo "usage: $0 x64|arm64 alpine|debian" >&2; exit 2 ;;
    esac
    case "$flavour" in
      alpine) image=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 ;;
      debian) image=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 ;;
      *) echo "usage: $0 x64|arm64 alpine|debian" >&2; exit 2 ;;
    esac
    root="$(cd "$(dirname "$0")/.." && pwd)"
    [ -f "$root/dist/index.js" ] || { echo "dist/index.js missing: run yarn build first (the test supervisor is the package's 9P server)" >&2; exit 2; }
    [ -f "$root/lib/linux-$arch/vfspreload.so" ] || { echo "lib/linux-$arch/vfspreload.so missing: run native/build.sh $arch first" >&2; exit 2; }
    exec docker run --rm --platform "$platform" -e FLAVOUR="$flavour" -e SHIM="/w/lib/linux-$arch/vfspreload.so" \
      -v "$root:/w:ro" "$image" sh /w/native/test.sh
  fi
  # C toolchain for the test callers only; the shim under test is the built artifact.
  case "$FLAVOUR" in
    alpine) apk add --no-cache gcc musl-dev linux-headers >/dev/null 2>&1 ;;
    debian) { apt-get -qq update && apt-get -qq install -y --no-install-recommends gcc libc6-dev binutils; } >/dev/null 2>&1 ;;
  esac
  echo "shim: $SHIM on $FLAVOUR"
  # the shell performs redirections itself, so it must be preloaded too
  exec env VFS_STAGE=1 LD_PRELOAD="$SHIM" VFS_MOUNTS=/vfs=/tmp/vfsstore sh "$0"
fi
fail() { echo "FAIL: $*"; exit 1; }
# in_order "log" "op" "op" …: each op appears in the log after the previous one
in_order() {
  rest="$1"; shift
  for op in "$@"; do
    case "$rest" in *"$op "*) rest="${rest#*"$op "}" ;; *) return 1 ;; esac
  done
}

# busybox (dynamically linked against musl) path ops
ls /vfs >/dev/null || fail "ls /vfs"
echo hi > /vfs/a
[ "$(cat /vfs/a)" = "hi" ] || fail "cat"
[ -f /tmp/vfsstore/a ] || fail "persist to backing"
mkdir /vfs/d
mv /vfs/a /vfs/d/b
[ "$(cat /vfs/d/b)" = "hi" ] || fail "mv"
cp /vfs/d/b /vfs/d/c
touch /vfs/d/c
chmod 600 /vfs/d/c
[ "$(stat -c %a /vfs/d/c)" = "600" ] || fail "chmod/stat"
truncate -s 0 /vfs/d/c
[ ! -s /vfs/d/c ] || fail "truncate"
ln -s /vfs/d/b /vfs/lnk
[ "$(cat /vfs/lnk)" = "hi" ] || fail "symlink follow"
[ "$(readlink /vfs/lnk)" = "/vfs/d/b" ] || fail "readlink reverse-translate: $(readlink /vfs/lnk)"
ln /vfs/d/b /vfs/hard
[ "$(cat /vfs/hard)" = "hi" ] || fail "hardlink"
[ "$(cd /vfs/d && pwd)" = "/vfs/d" ] || fail "chdir/getcwd: $(cd /vfs/d && pwd)"
[ "$(cd /vfs/d && cat b)" = "hi" ] || fail "relative after chdir"
[ "$(ls /vfs | sort | tr '\n' ' ')" = "d hard lnk " ] || fail "ls: $(ls /vfs)"
rm /vfs/hard /vfs/lnk /vfs/d/c
rm /vfs/d/b
rmdir /vfs/d
[ -z "$(ls /vfs)" ] || fail "cleanup: $(ls /vfs)"
echo "busybox: ok"

# node (libuv): statx via raw syscall, openat, scandir, realpath, mkdtemp, rename
node -e '
const fs = require("fs"), path = require("path"), assert = require("assert");
assert.ok(fs.statSync("/vfs").isDirectory());
assert.ok(fs.lstatSync("/vfs").isDirectory());
fs.writeFileSync("/vfs/n.txt", "node");
assert.strictEqual(fs.statSync("/vfs/n.txt").size, 4);
assert.ok(fs.existsSync("/vfs/n.txt"));
assert.strictEqual(fs.readFileSync("/vfs/n.txt", "utf8"), "node");
fs.mkdirSync("/vfs/x/y", { recursive: true });
fs.renameSync("/vfs/n.txt", "/vfs/x/y/n.txt");
assert.deepStrictEqual(fs.readdirSync("/vfs/x/y"), ["n.txt"]);
assert.strictEqual(fs.realpathSync("/vfs/x/../x/y/n.txt"), "/vfs/x/y/n.txt");
const t = fs.mkdtempSync("/vfs/tmp-");
assert.ok(t.startsWith("/vfs/tmp-") && fs.statSync(t).isDirectory(), t);
assert.ok(fs.existsSync("/tmp/vfsstore/" + path.basename(t)));
fs.symlinkSync("/vfs/x/y/n.txt", "/vfs/s");
assert.strictEqual(fs.readlinkSync("/vfs/s"), "/vfs/x/y/n.txt");
assert.strictEqual(fs.readFileSync("/vfs/s", "utf8"), "node");
process.chdir("/vfs/x");
assert.strictEqual(process.cwd(), "/vfs/x");
assert.strictEqual(fs.readFileSync("y/n.txt", "utf8"), "node");
process.chdir("/");
fs.rmSync("/vfs/x", { recursive: true });
fs.rmSync(t, { recursive: true });
fs.unlinkSync("/vfs/s");
assert.deepStrictEqual(fs.readdirSync("/vfs"), []);
assert.ok(!fs.existsSync("/vfsx"));
console.log("node: ok");
'

# fopen path via a tiny C program
cat > /tmp/f.c <<'EOF'
#include <stdio.h>
#include <string.h>
int main(void) {
  FILE *f = fopen("/vfs/f.txt", "w"); if (!f) return 1;
  fputs("fopen", f); fclose(f);
  char b[16] = {0}; f = fopen("/vfs/f.txt", "r"); if (!f) return 2;
  fgets(b, sizeof b, f); fclose(f);
  if (strcmp(b, "fopen")) return 3;
  if (remove("/vfs/f.txt")) return 4;
  return 0;
}
EOF
gcc /tmp/f.c -o /tmp/f && /tmp/f || fail "fopen/remove (rc=$?)"
echo "fopen: ok"

# glibc entry points and the newer hooks, from C. Built fortified on debian so the __*_2 / __*_chk
# entry points are the ones actually called.
cat > /tmp/g.c <<'EOF'
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>
extern char **environ;

static int spawn_ok(const char *path) {
  pid_t pid; int st; char *argv[] = { "true", NULL };
  if (posix_spawn(&pid, path, NULL, NULL, argv, environ)) return 0;
  return waitpid(pid, &st, 0) == pid && WIFEXITED(st) && WEXITSTATUS(st) == 0;
}

int main(void) {
  volatile int rd = O_RDONLY;                 /* non-constant: fortify routes open() to __open_2 */
  volatile size_t sz = PATH_MAX;              /* non-constant: getcwd/readlink go to __*_chk */
  char buf[PATH_MAX];

  int fd = open("/vfs/g.txt", O_CREAT | O_WRONLY | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "glibc", 5) != 5 || close(fd)) return 1;
  if ((fd = open("/vfs/g.txt", rd)) < 0) return 2;
  close(fd);
  if (!realpath("/vfs/g.txt", buf) || strcmp(buf, "/vfs/g.txt")) return 3;
  if (chdir("/vfs") || !getcwd(buf, sz) || strcmp(buf, "/vfs")) return 4;
  if (chdir("/")) return 4;
  if (symlink("/vfs/g.txt", "/vfs/gl")) return 5;
  ssize_t n = readlink("/vfs/gl", buf, sz);
  if (n != 10 || strncmp(buf, "/vfs/g.txt", 10)) return 6;

  /* xattrs, unless the filesystem under /tmp refuses user xattrs outright */
  int plain = open("/tmp/plain", O_CREAT | O_WRONLY, 0644); close(plain);
  if (setxattr("/tmp/plain", "user.k", "v", 1, 0) == 0) {
    char v[16];
    if (setxattr("/vfs/g.txt", "user.k", "v", 1, 0)) return 10;
    if (getxattr("/vfs/g.txt", "user.k", v, sizeof v) != 1 || v[0] != 'v') return 11;
    if (lgetxattr("/vfs/g.txt", "user.k", v, sizeof v) != 1) return 11;
    if (listxattr("/vfs/g.txt", v, sizeof v) <= 0 || llistxattr("/vfs/g.txt", v, sizeof v) <= 0) return 12;
    if (removexattr("/vfs/g.txt", "user.k")) return 13;
    if (getxattr("/tmp/vfsstore/g.txt", "user.k", v, sizeof v) != -1 || errno != ENODATA) return 13;
  } else if (errno != ENOTSUP) {
    return 14;
  } else {
    puts("xattr: skipped (ENOTSUP under /tmp)");
  }

  /* posix_spawn a program stored under the mount, and one outside it */
  if (system("cp /bin/true /vfs/true")) return 16;
  if (!spawn_ok("/vfs/true")) return 17;
  if (!spawn_ok("/bin/true")) return 18;

  /* euidaccess / eaccess (GNU test -r) */
  if (euidaccess("/vfs/g.txt", R_OK) || eaccess("/vfs/g.txt", R_OK)) return 50;

  /* get_current_dir_name never shows the backing directory, with or without a matching $PWD */
  if (chdir("/vfs")) return 51;
  char *cwd = get_current_dir_name();
  if (!cwd || strcmp(cwd, "/vfs")) return 51;
  free(cwd);
  setenv("PWD", "/vfs", 1);
  if (!(cwd = get_current_dir_name()) || strcmp(cwd, "/vfs")) return 51;
  free(cwd);
  unsetenv("PWD");
  if (chdir("/")) return 51;

  /* the mkstemp variants with flags and suffixes */
  char t1[] = "/vfs/oXXXXXX", t2[] = "/vfs/sXXXXXX.txt", t3[] = "/vfs/pXXXXXX.txt";
  int t;
  if ((t = mkostemp(t1, O_CLOEXEC)) < 0 || strncmp(t1, "/vfs/o", 6)) return 52;
  close(t);
  if ((t = mkostemps(t2, 4, O_CLOEXEC)) < 0 || strncmp(t2, "/vfs/s", 6) || strcmp(t2 + 12, ".txt")) return 53;
  close(t);
  if ((t = mkstemps(t3, 4)) < 0 || strncmp(t3, "/vfs/p", 6) || strcmp(t3 + 12, ".txt")) return 54;
  close(t);
  char bk[PATH_MAX];
  snprintf(bk, sizeof bk, "/tmp/vfsstore/%s", t2 + 5);
  if (access(bk, F_OK)) return 54;
  unlink(t1); unlink(t2); unlink(t3);

  /* spawn file actions name VFS paths: the child opens and changes into the backing directory */
  pid_t sp; int sst;
  posix_spawn_file_actions_t fa;
  char *cat_argv[] = { "sh", "-c", "test \"$(cat)\" = glibc", NULL };
  posix_spawn_file_actions_init(&fa);
  if (posix_spawn_file_actions_addopen(&fa, 0, "/vfs/g.txt", O_RDONLY, 0)) return 55;
  if (posix_spawn(&sp, "/bin/sh", &fa, NULL, cat_argv, environ) || waitpid(sp, &sst, 0) != sp ||
      !WIFEXITED(sst) || WEXITSTATUS(sst)) return 55;
  posix_spawn_file_actions_destroy(&fa);
  posix_spawn_file_actions_init(&fa);
  if (posix_spawn_file_actions_addopen(&fa, 1, "/vfs/out.txt", O_WRONLY | O_CREAT, 0644) != ENOTSUP) return 56;
  posix_spawn_file_actions_destroy(&fa);
  char *cd_argv[] = { "sh", "-c", "test -f g.txt", NULL };
  posix_spawn_file_actions_init(&fa);
  if (posix_spawn_file_actions_addchdir_np(&fa, "/vfs")) return 57;
  if (posix_spawn(&sp, "/bin/sh", &fa, NULL, cd_argv, environ) || waitpid(sp, &sst, 0) != sp ||
      !WIFEXITED(sst) || WEXITSTATUS(sst)) return 57;
  posix_spawn_file_actions_destroy(&fa);

  /* posix_spawnp finds a program in a PATH entry under the mount. argv[0] stays "true": on alpine
   * the copy is busybox, which picks its applet by that name. */
  if (mkdir("/vfs/bin", 0755) || system("cp /bin/true /vfs/bin/vfstrue")) return 58;
  char *oldpath = strdup(getenv("PATH"));
  char newpath[PATH_MAX];
  snprintf(newpath, sizeof newpath, "/vfs/bin:%s", oldpath);
  setenv("PATH", newpath, 1);
  char *vt_argv[] = { "true", NULL };
  int spr = posix_spawnp(&sp, "vfstrue", NULL, NULL, vt_argv, environ);
  setenv("PATH", oldpath, 1);
  free(oldpath);
  if (spr) return 61;
  if (waitpid(sp, &sst, 0) != sp || !WIFEXITED(sst) || WEXITSTATUS(sst)) return 62;

#ifdef __GLIBC__
  struct dirent **list;
  if (scandirat(AT_FDCWD, "/vfs", &list, NULL, alphasort) < 2) return 15;

  struct stat64 s64; struct statfs64 f64; struct statvfs64 v64; struct dirent64 **l64;
  if (stat64("/vfs/g.txt", &s64) || s64.st_size != 5) return 20;
  if (lstat64("/vfs/gl", &s64) || !S_ISLNK(s64.st_mode)) return 21;
  if (fstatat64(AT_FDCWD, "/vfs/g.txt", &s64, 0)) return 22;
  if (statfs64("/vfs", &f64) || statvfs64("/vfs", &v64)) return 23;
  if (truncate64("/vfs/g.txt", 2) || stat64("/tmp/vfsstore/g.txt", &s64) || s64.st_size != 2) return 24;
  if ((fd = creat64("/vfs/c.txt", 0644)) < 0) return 25;
  close(fd);
  FILE *f = fopen64("/vfs/c.txt", "w");
  if (!f || !(f = freopen64("/vfs/c.txt", "r", f))) return 26;
  fclose(f);
  if (scandir64("/vfs", &l64, NULL, alphasort64) < 2) return 27;
  char tmpl[] = "/vfs/tmpXXXXXX";
  if ((fd = mkstemp64(tmpl)) < 0 || strncmp(tmpl, "/vfs/tmp", 8)) return 28;
  close(fd); unlink(tmpl);

  if (renameat2(AT_FDCWD, "/vfs/g.txt", AT_FDCWD, "/vfs/h.txt", RENAME_NOREPLACE)) return 30;
  if (access("/tmp/vfsstore/h.txt", F_OK) || !access("/tmp/vfsstore/g.txt", F_OK)) return 31;
  if (renameat2(AT_FDCWD, "/vfs/h.txt", AT_FDCWD, "/vfs/c.txt", RENAME_EXCHANGE) != -1 || errno != EINVAL) return 32;
  if (access("/tmp/vfsstore/h.txt", F_OK)) return 33;

  /* binaries built against glibc < 2.33 (official node) stat through the __xstat family; the
   * loader binds their versioned references to the shim's hooks (checked with LD_DEBUG below) */
  int (*xstat64)(int, const char *, struct stat64 *) = dlsym(RTLD_DEFAULT, "__xstat64");
  int (*lxstat64)(int, const char *, struct stat64 *) = dlsym(RTLD_DEFAULT, "__lxstat64");
  int (*xstat)(int, const char *, struct stat *) = dlsym(RTLD_DEFAULT, "__xstat");
  struct stat xs;
#if defined(__x86_64__)
  const int ver = 1;                          /* _STAT_VER_LINUX */
#else
  const int ver = 0;                          /* _STAT_VER_KERNEL on aarch64 */
#endif
  if (!xstat64 || !lxstat64 || !xstat) return 35;
  if (xstat64(ver, "/vfs/h.txt", &s64) || s64.st_size != 2) return 36;
  if (lxstat64(ver, "/vfs/gl", &s64) || !S_ISLNK(s64.st_mode)) return 37;
  if (xstat(ver, "/vfs/h.txt", &xs) || xs.st_size != 2) return 38;
  if (xstat64(99, "/vfs/h.txt", &s64) != -1 || errno != EINVAL) return 39;

  /* mknod through the pre-2.33 wrappers lands in the backing directory */
  int (*xmknod)(int, const char *, mode_t, dev_t *) = dlsym(RTLD_DEFAULT, "__xmknod");
  int (*xmknodat)(int, int, const char *, mode_t, dev_t *) = dlsym(RTLD_DEFAULT, "__xmknodat");
  dev_t nodev = 0;
  if (!xmknod || !xmknodat) return 59;
  if (xmknod(0, "/vfs/fifo1", S_IFIFO | 0644, &nodev) || xmknodat(0, AT_FDCWD, "/vfs/fifo2", S_IFIFO | 0644, &nodev)) return 59;
  if (stat("/tmp/vfsstore/fifo1", &xs) || !S_ISFIFO(xs.st_mode) || stat("/tmp/vfsstore/fifo2", &xs) || !S_ISFIFO(xs.st_mode)) return 59;
  unlink("/tmp/vfsstore/fifo1"); unlink("/tmp/vfsstore/fifo2");

  /* the LFS names of the mkstemp variants */
  char t4[] = "/vfs/qXXXXXX", t5[] = "/vfs/rXXXXXX.txt", t6[] = "/vfs/uXXXXXX.txt";
  if ((fd = mkostemp64(t4, O_CLOEXEC)) < 0 || strncmp(t4, "/vfs/q", 6)) return 60;
  close(fd);
  if ((fd = mkostemps64(t5, 4, 0)) < 0 || strncmp(t5, "/vfs/r", 6)) return 60;
  close(fd);
  if ((fd = mkstemps64(t6, 4)) < 0 || strncmp(t6, "/vfs/u", 6)) return 60;
  close(fd);
  unlink(t4); unlink(t5); unlink(t6);

  /* the remaining fortified and LFS entry points */
  if ((fd = openat(AT_FDCWD, "/vfs/h.txt", rd)) < 0) return 40;
  close(fd);
  if ((fd = open64("/vfs/h.txt", rd)) < 0) return 41;
  struct flock fl = { .l_type = F_RDLCK, .l_whence = SEEK_SET };
  if (fcntl64(fd, F_SETLK, &fl)) return 42;
  fl.l_type = F_UNLCK;
  if (fcntl64(fd, F_SETLK, &fl)) return 42;
  close(fd);
  if (readlinkat(AT_FDCWD, "/vfs/gl", buf, sz) != 10 || strncmp(buf, "/vfs/g.txt", 10)) return 43;
  if (scandirat64(AT_FDCWD, "/vfs", &l64, NULL, alphasort64) < 2) return 44;

  /* outside every mount RENAME_EXCHANGE is the kernel's call: same result as the raw syscall */
  int xa = open("/tmp/xa", O_CREAT | O_WRONLY | O_TRUNC, 0644), xb = open("/tmp/xb", O_CREAT | O_WRONLY | O_TRUNC, 0644);
  if (xa < 0 || xb < 0 || write(xa, "a", 1) != 1 || write(xb, "b", 1) != 1) return 45;
  close(xa); close(xb);
  long raw = syscall(SYS_renameat2, AT_FDCWD, "/tmp/xa", AT_FDCWD, "/tmp/xb", RENAME_EXCHANGE);
  int rawerr = errno;
  if (renameat2(AT_FDCWD, "/tmp/xa", AT_FDCWD, "/tmp/xb", RENAME_EXCHANGE) != raw || (raw && errno != rawerr)) return 46;
  char c = 0;
  if ((xa = open("/tmp/xa", O_RDONLY)) < 0 || read(xa, &c, 1) != 1 || c != 'a') return 47;
  close(xa); unlink("/tmp/xa"); unlink("/tmp/xb");

  /* O_CREAT through __open_2/__openat_2 has no mode: glibc aborts rather than invent one */
  volatile int cr = O_CREAT | O_WRONLY;
  for (int at = 0; at < 2; at++) {
    pid_t child = fork();
    if (child == 0) { if (at) openat(AT_FDCWD, "/vfs/nomode", cr); else open("/vfs/nomode", cr); _exit(0); }
    int cst;
    if (waitpid(child, &cst, 0) != child || !WIFSIGNALED(cst) || WTERMSIG(cst) != SIGABRT) return 48;
    if (!access("/tmp/vfsstore/nomode", F_OK)) return 49;
  }

  /* a fortified caller with an undersized buffer dies the way glibc makes it die */
  pid_t pid = fork();
  if (pid == 0) { volatile size_t big = PATH_MAX; char small[8]; getcwd(small, big); _exit(0); }
  int st;
  if (waitpid(pid, &st, 0) != pid || !WIFSIGNALED(st) || WTERMSIG(st) != SIGABRT) return 34;
#endif
  return 0;
}
EOF
if [ "$FLAVOUR" = debian ]; then
  gcc -O2 -D_FORTIFY_SOURCE=2 /tmp/g.c -o /tmp/g
  for sym in __open_2 __openat_2 __open64_2 __realpath_chk __getcwd_chk __readlink_chk __readlinkat_chk fcntl64 scandirat64; do
    nm -D /tmp/g | grep -q " $sym" || fail "test caller does not import $sym"
  done
else
  gcc -O2 /tmp/g.c -o /tmp/g
fi
/tmp/g || fail "glibc entry points / new hooks (rc=$?)"
if [ "$FLAVOUR" = debian ]; then
  # node built against an older glibc imports these: its stat and lock calls must bind to the shim
  for sym in __xstat64 __lxstat64 fcntl64; do
    if ! nm -D --undefined-only "$(command -v node)" | grep -qE " $sym(@|\$)"; then
      echo "hooks: node does not import $sym, binding not checked"
      continue
    fi
    LD_DEBUG=bindings node -e 0 2>&1 | grep -q "binding file node .* to $SHIM .*\`$sym'" ||
      fail "node's $sym does not bind to the shim"
  done
fi
rm -rf /vfs/h.txt /vfs/c.txt /vfs/gl /vfs/g.txt /vfs/true /vfs/bin
echo "hooks: ok"

# the new hooks leave paths outside every mount alone
echo outside > /tmp/outside.a
mv /tmp/outside.a /tmp/outside.b && [ "$(cat /tmp/outside.b)" = outside ] || fail "mv outside the mount"

# off switch: without the preload, /vfs does not exist
env -u LD_PRELOAD sh -c '[ ! -e /vfs ]' || fail "/vfs visible without preload"
env -u LD_PRELOAD sh -c '[ -d /tmp/vfsstore ]' || fail "backing dir missing"

# several mounts: the longest prefix wins and each maps to its own backing directory
env VFS_MOUNTS=/a=/tmp/store/a:/a/inner=/tmp/store/inner:/b=/tmp/store/b sh -euc '
fail() { echo "FAIL: $*"; exit 1; }
echo one > /a/f
echo two > /b/f
echo deep > /a/inner/x
[ "$(cat /a/f)" = "one" ] && [ "$(cat /b/f)" = "two" ] || fail "mounts: read back"
[ -f /tmp/store/a/f ] && [ -f /tmp/store/b/f ] || fail "mounts: each backing directory"
[ -f /tmp/store/inner/x ] && [ ! -e /tmp/store/a/inner/x ] || fail "mounts: nested mount wins for its subtree"
[ ! -e /vfs ] || fail "mounts: /vfs present although VFS_MOUNTS is set"
[ ! -e /ax ] && [ ! -e /bb ] || fail "mounts: lookalike prefix"
ln -s /b/f /a/lnk
[ "$(readlink /a/lnk)" = "/b/f" ] || fail "mounts: readlink across mounts: $(readlink /a/lnk)"
[ "$(cat /a/lnk)" = "two" ] || fail "mounts: symlink across mounts"
[ "$(cd /b && pwd)" = "/b" ] || fail "mounts: getcwd"
[ "$(cd /a/inner && pwd)" = "/a/inner" ] || fail "mounts: getcwd nested: $(cd /a/inner && pwd)"
mv /a/f /b/g
[ "$(cat /b/g)" = "one" ] && [ ! -e /a/f ] || fail "mounts: mv across mounts"
node -e "
const fs = require(\"fs\"), assert = require(\"assert\");
assert.strictEqual(fs.realpathSync(\"/a/inner/../inner/x\"), \"/a/inner/x\");
assert.deepStrictEqual(fs.readdirSync(\"/b\").sort(), [\"f\", \"g\"]);
" || fail "mounts: node"
' || fail "mounts"
echo "mounts: ok"

# supervisor socket tests: the package's 9P server, recording every adapter hook
rm -f /tmp/ops.log /tmp/vfs.ready
node /w/native/test-server.js &
SRVPID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do [ -f /tmp/vfs.ready ] && break; sleep 0.2; done
[ -f /tmp/vfs.ready ] || fail "9P test server did not start"

export VFS_SOCKET=/tmp/vfs.sock
rm -f /tmp/ops.log

if cat /vfs/denied 2>&1 | grep -q "Permission denied"; then
  :
else
  fail "cat /vfs/denied did not fail with Permission denied"
fi

if node -e "fs.writeFileSync('/vfs/flushfail', 'x')" 2>&1 | grep -q "EIO"; then
  :
else
  fail "flushfail did not throw EIO"
fi

rm -f /tmp/ops.log
touch /vfs/tracked
ls /vfs >/dev/null
mkdir /vfs/d2
mv /vfs/tracked /vfs/d2/tracked2
rm /vfs/d2/tracked2
rmdir /vfs/d2
echo x > /tmp/notvfs   # outside the prefix: must not reach the supervisor

LOG=$(cat /tmp/ops.log | tr '\n' ' ')
if [ "$FLAVOUR" = alpine ]; then
  # busybox's exact call sequence, pinned as before
  case "$LOG" in
    *"stat /vfs/tracked stat /vfs/tracked fetch /vfs/tracked open /vfs/tracked flush /vfs/tracked stat /vfs list /vfs stat /vfs mkdir /vfs/d2 stat /vfs stat /vfs/d2 rename /vfs/tracked /vfs/d2/tracked2 stat /vfs stat /vfs/d2 stat /vfs/d2/tracked2 stat /vfs/d2 unlink /vfs/d2/tracked2 stat /vfs unlink /vfs/d2 "*) ;;
    *) fail "log did not match: $LOG" ;;
  esac
else
  # GNU coreutils makes more calls; the operations must still arrive, in order
  in_order "$LOG" "open /vfs/tracked" "flush /vfs/tracked" "list /vfs" "mkdir /vfs/d2" \
    "rename /vfs/tracked /vfs/d2/tracked2" "unlink /vfs/d2/tracked2" "unlink /vfs/d2" ||
    fail "log out of order: $LOG"
fi

if grep -q "/tmp/notvfs" /tmp/ops.log 2>/dev/null; then
  fail "logged non-/vfs path"
fi

# dup2 onto a descriptor open on a VFS file closes that file: it is flushed then, while the
# process lives, not when its session ends
rm -f /tmp/ops.log
sh -c 'exec 3>/vfs/dupped; echo x >&3; exec 3>/dev/null; grep -q "flush /vfs/dupped" /tmp/ops.log' ||
  fail "dup2 over a VFS descriptor did not flush: $(tr '\n' ' ' < /tmp/ops.log)"
rm -f /vfs/dupped

# the supervisor socket sits above the descriptors programs pick, and survives a program closing,
# or dup2-ing onto, its number (in C: dash only redirects descriptors 0-9)
cat > /tmp/sock.c <<'EOF'
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int socket_fd(void) {
  DIR *d = opendir("/proc/self/fd");
  struct dirent *e;
  char p[64], l[64];
  int n = -1;
  while (d && (e = readdir(d))) {
    snprintf(p, sizeof p, "/proc/self/fd/%s", e->d_name);
    ssize_t k = readlink(p, l, sizeof l - 1);
    if (k > 0) { l[k] = 0; if (!strncmp(l, "socket:", 7)) n = atoi(e->d_name); }
  }
  if (d) closedir(d);
  return n;
}
static int probe(void) {
  int fd = open("/vfs/sockprobe", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "x", 1) != 1 || close(fd)) return 0;
  FILE *f = fopen("/tmp/ops.log", "r");
  char line[512];
  int flushed = 0;
  while (f && fgets(line, sizeof line, f)) flushed |= strstr(line, "flush /vfs/sockprobe") != NULL;
  if (f) fclose(f);
  unlink("/tmp/ops.log");
  return flushed;
}
int main(void) {
  if (!probe()) { puts("no flush before"); return 1; }
  int n = socket_fd();
  if (n < 256) { printf("socket at fd %d\n", n); return 2; }
  close(n);
  if (!probe()) { printf("lost after close(%d)\n", n); return 3; }
  if (dup2(open("/dev/null", O_WRONLY), n) != n) { printf("dup2 onto %d failed\n", n); return 4; }
  if (!probe()) { printf("lost after dup2 onto %d\n", n); return 5; }
  return 0;
}
EOF
gcc -O2 /tmp/sock.c -o /tmp/sock
rm -f /tmp/ops.log
/tmp/sock || fail "supervisor socket"
rm -f /vfs/sockprobe

# paths relative to a directory descriptor or to a cwd under the mount reach the supervisor under
# their virtual path, as absolute ones do (directory walkers: rm -r, find, tar -x, shutil.rmtree)
cat > /tmp/rel.c <<'EOF'
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
int main(void) {
  if (mkdir("/vfs/rel", 0755)) return 1;
  int d = open("/vfs/rel", O_RDONLY | O_DIRECTORY);
  if (d < 0) return 2;
  int fd = openat(d, "made.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "x", 1) != 1 || close(fd)) return 3;
  if (mkdirat(d, "sub", 0755)) return 4;
  if (renameat(d, "made.txt", d, "sub/moved.txt")) return 5;
  struct stat st;
  if (fstatat(d, "sub/moved.txt", &st, 0)) return 6;
  if (unlinkat(d, "sub/moved.txt", 0) || unlinkat(d, "sub", AT_REMOVEDIR)) return 7;
  if (chdir("/vfs/rel")) return 8;
  fd = open("cwd.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "y", 1) != 1 || close(fd)) return 9;
  if (mkdir("cwdsub", 0755) || rename("cwd.txt", "cwdsub/cwd2.txt")) return 10;
  if (unlink("cwdsub/cwd2.txt") || rmdir("cwdsub") || chdir("/")) return 11;
  close(d);
  return rmdir("/vfs/rel") ? 12 : 0;
}
EOF
gcc -O2 /tmp/rel.c -o /tmp/rel
rm -f /tmp/ops.log
/tmp/rel || fail "relative paths: rel.c (rc=$?)"
LOG=$(tr '\n' ' ' < /tmp/ops.log)
for op in "open /vfs/rel/made.txt" "flush /vfs/rel/made.txt" "mkdir /vfs/rel/sub" \
  "rename /vfs/rel/made.txt /vfs/rel/sub/moved.txt" "stat /vfs/rel/sub/moved.txt" \
  "unlink /vfs/rel/sub/moved.txt" "unlink /vfs/rel/sub" "open /vfs/rel/cwd.txt" "flush /vfs/rel/cwd.txt" \
  "mkdir /vfs/rel/cwdsub" "rename /vfs/rel/cwd.txt /vfs/rel/cwdsub/cwd2.txt" "unlink /vfs/rel/cwdsub/cwd2.txt" \
  "unlink /vfs/rel/cwdsub"; do
  case "$LOG" in *"$op "*) ;; *) fail "relative paths: supervisor never saw '$op' in: $LOG" ;; esac
done

# rm -r walks with descriptor-relative unlinkat (coreutils fts) or full paths (busybox): either way
# every object is deleted at the supervisor, not just its local copy
mkdir -p /vfs/tree/a/b
echo 1 > /vfs/tree/a/one
echo 2 > /vfs/tree/a/b/two
rm -f /tmp/ops.log
rm -r /vfs/tree || fail "rm -r /vfs/tree"
LOG=$(tr '\n' ' ' < /tmp/ops.log)
for op in "unlink /vfs/tree/a/b/two" "unlink /vfs/tree/a/one" "unlink /vfs/tree/a/b" "unlink /vfs/tree/a" "unlink /vfs/tree"; do
  case "$LOG" in *"$op "*) ;; *) fail "rm -r: supervisor never saw '$op' in: $LOG" ;; esac
done
echo "relative paths: ok"

# a second mount reaches the supervisor under its own virtual path
rm -f /tmp/ops.log
env VFS_MOUNTS=/vfs=/tmp/vfsstore:/b=/tmp/store/b sh -c 'echo x > /b/reported' || fail "mounts: write to second mount with a supervisor"
grep -q "open /b/reported" /tmp/ops.log && grep -q "flush /b/reported" /tmp/ops.log ||
  fail "mounts: second mount not reported: $(tr '\n' ' ' < /tmp/ops.log)"

# advisory locks: a SQLite write transaction becomes lock -> flush -> unlock,
# a read transaction becomes revalidate, and a refused lock is SQLITE_BUSY.
rm -f /tmp/ops.log
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/vfs/t.sqlite");
db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
db.exec("CREATE TABLE t (v TEXT)");
db.exec("INSERT INTO t VALUES (1)");
console.log(JSON.stringify(db.prepare("SELECT count(*) AS n FROM t").get()));
db.close();
' | grep -q '"n":1' || fail "sqlite round trip under the shim"
LOG=$(cat /tmp/ops.log | tr '\n' ' ')
for op in "lock /vfs/t.sqlite" "flush /vfs/t.sqlite" "unlock /vfs/t.sqlite" "revalidate /vfs/t.sqlite"; do
  case "$LOG" in *"$op "*) ;; *) fail "missing '$op' in: $LOG";; esac
done
case "$LOG" in
  *"lock /vfs/t.sqlite"*"unlock /vfs/t.sqlite"*) ;;
  *) fail "lock did not precede unlock: $LOG";;
esac
if node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/vfs/busy.sqlite");
db.exec("CREATE TABLE t (v TEXT)");
' 2>&1 | grep -qiE "locked|busy|EAGAIN"; then
  :
else
  fail "refused lock did not surface as SQLITE_BUSY"
fi
echo "locks: ok"

kill $SRVPID
wait $SRVPID 2>/dev/null || true

if ls /vfs 2>/dev/null; then
  fail "ls /vfs should fail with unreachable socket"
fi

unset VFS_SOCKET
echo "socket: ok"

echo "ALL OK"
