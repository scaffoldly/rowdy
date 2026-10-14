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
