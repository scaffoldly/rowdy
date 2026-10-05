/*
 * vfspreload.c — a userspace VFS via LD_PRELOAD libc interposition.
 *
 * The sandbox denies every kernel-mediated VFS primitive (/dev/fuse, mount(2),
 * namespaces, ptrace, seccomp-notify — all EPERM/ENOENT). The one path that
 * survives is intercepting libc's path entry points in-process. This shim turns
 * a virtual prefix (VFS_PREFIX, default "/vfs") into a full, writable, persistent
 * filesystem backed by a real directory (VFS_BACKING, default "/tmp/vfsstore").
 *
 * It is a genuine filesystem surface: create, read, write, stat, list, mkdir,
 * rename, chmod, delete all work, because each path-based call is translated and
 * delegated to the real libc against the backing store. Calls that hand a path
 * back to the program (getcwd, realpath, readlink) are translated in reverse so
 * the backing directory never leaks into the program's view.
 *
 * musl note: within libc, one function calling another (fopen->open,
 * scandir->opendir, remove->unlink) binds internally and does NOT route through
 * a preloaded symbol. So we must interpose every PUBLIC entry point the calling
 * program uses directly, not rely on one wrapper covering another. That is
 * exactly what this file does.
 *
 * Scope / ceiling (inherent to the preload model):
 *   - only processes started with this .so in LD_PRELOAD see the VFS;
 *   - only dynamically-linked musl callers that invoke these libc symbols;
 *   - it is not a kernel mountpoint — unrelated processes cannot see /vfs;
 *   - no mmap of virtual files, no nftw/glob/posix_spawn translation (yet).
 *
 * Build:  gcc -shared -fPIC vfspreload.c -o vfspreload.so
 * Run:    LD_PRELOAD=/usr/local/lib/rowdy/vfspreload.so \
 *         VFS_PREFIX=/vfs VFS_BACKING=/tmp/vfsstore <program>
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>
#include <limits.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <utime.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/syscall.h>

/* ---- configuration (read once) ------------------------------------------ */

static const char *g_prefix;    /* virtual prefix, e.g. "/vfs"            */
static size_t      g_prefixlen;
static const char *g_backing;   /* real backing dir, e.g. "/tmp/vfsstore" */
static size_t      g_backinglen;

static void vfs_init(void) __attribute__((constructor));
static void vfs_init(void) {
    if (g_prefix) return;

    const char *p = getenv("VFS_PREFIX");
    g_prefix = (p && *p) ? p : "/vfs";
    g_prefixlen = strlen(g_prefix);

    const char *b = getenv("VFS_BACKING");
    g_backing = (b && *b) ? b : "/tmp/vfsstore";
    g_backinglen = strlen(g_backing);

    /* Best-effort create the backing root so the VFS exists on first use. */
    int (*real_mkdir)(const char *, mode_t) = dlsym(RTLD_NEXT, "mkdir");
    int saved = errno;
    if (real_mkdir) real_mkdir(g_backing, 0777);
    errno = saved;
}

/* ---- path translation ---------------------------------------------------- */

/*
 * If `path` is absolute and under the virtual prefix, rewrite it into the
 * backing store in `buf` and return `buf`. Otherwise return `path` unchanged.
 *
 * Only absolute /vfs paths are translated. Relative paths are left alone: a
 * dirfd obtained via opendir/open on a /vfs path (or a cwd set via chdir)
 * already points into the backing store, so relative resolution is correct on
 * its own.
 */
static const char *xlate(const char *path, char *buf, size_t bufsz) {
    if (!path) return path;
    if (!g_prefix) vfs_init();  /* hooked before our constructor ran */
    if (strncmp(path, g_prefix, g_prefixlen) != 0) return path;
    char after = path[g_prefixlen];
    if (after != '/' && after != '\0') return path;   /* e.g. "/vfsx" is not ours */
    /* path + g_prefixlen keeps the leading '/' (or "" for the root itself). */
    size_t restlen = strlen(path + g_prefixlen);
    if (g_backinglen + restlen + 1 > bufsz) return path;   /* too long; fall through */
    memcpy(buf, g_backing, g_backinglen);
    memcpy(buf + g_backinglen, path + g_prefixlen, restlen + 1);
    return buf;
}

/*
 * Reverse: if `buf` (NUL-terminated, capacity `bufsz`) is under the backing
 * store, rewrite it in place to the virtual prefix. Returns 1 if rewritten,
 * 0 if not ours, -1 if it would not fit.
 */
static int unxlate(char *buf, size_t bufsz) {
    if (!g_prefix) vfs_init();
    if (strncmp(buf, g_backing, g_backinglen) != 0) return 0;
    char after = buf[g_backinglen];
    if (after != '/' && after != '\0') return 0;
    size_t restlen = strlen(buf + g_backinglen);
    if (g_prefixlen + restlen + 1 > bufsz) return -1;
    memmove(buf + g_prefixlen, buf + g_backinglen, restlen + 1);
    memcpy(buf, g_prefix, g_prefixlen);
    return 1;
}

#define XL(p) const char *rp_; char xb_[PATH_MAX]; rp_ = xlate((p), xb_, sizeof xb_)

#define XL2(a, b) \
    char ab_[PATH_MAX], bb_[PATH_MAX]; \
    const char *ra_ = xlate((a), ab_, sizeof ab_); \
    const char *rb_ = xlate((b), bb_, sizeof bb_)

#define REAL(name) \
    static typeof(&name) real_; \
    if (!real_) real_ = (typeof(&name))dlsym(RTLD_NEXT, #name)

/* ---- open family (variadic mode) ----------------------------------------- */

int open(const char *path, int flags, ...) {
    REAL(open);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
    }
    XL(path);
    return real_(rp_, flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
    REAL(openat);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
    }
    XL(path);
    return real_(dirfd, rp_, flags, mode);
}

int creat(const char *path, mode_t mode) {
    REAL(creat); XL(path); return real_(rp_, mode);
}

/* ---- stdio (musl binds fopen->open internally) --------------------------- */

FILE *fopen(const char *path, const char *mode) {
    REAL(fopen); XL(path); return real_(rp_, mode);
}
FILE *freopen(const char *path, const char *mode, FILE *stream) {
    REAL(freopen); XL(path); return real_(rp_, mode, stream);
}

/* ---- metadata ------------------------------------------------------------ */

int stat(const char *path, struct stat *st) {
    REAL(stat);  XL(path);  return real_(rp_, st);
}
int lstat(const char *path, struct stat *st) {
    REAL(lstat); XL(path);  return real_(rp_, st);
}
int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    REAL(fstatat); XL(path); return real_(dirfd, rp_, st, flags);
}
int access(const char *path, int mode) {
    REAL(access); XL(path); return real_(rp_, mode);
}
int faccessat(int dirfd, const char *path, int mode, int flags) {
    REAL(faccessat); XL(path); return real_(dirfd, rp_, mode, flags);
}
int statx(int dirfd, const char *path, int flags, unsigned mask, struct statx *buf) {
    REAL(statx); XL(path); return real_(dirfd, rp_, flags, mask, buf);
}
int statfs(const char *path, struct statfs *buf) {
    REAL(statfs); XL(path); return real_(rp_, buf);
}
int statvfs(const char *path, struct statvfs *buf) {
    REAL(statvfs); XL(path); return real_(rp_, buf);
}

/* ---- attribute mutation -------------------------------------------------- */

int chmod(const char *path, mode_t mode) {
    REAL(chmod); XL(path); return real_(rp_, mode);
}
int fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
    REAL(fchmodat); XL(path); return real_(dirfd, rp_, mode, flags);
}
int chown(const char *path, uid_t uid, gid_t gid) {
    REAL(chown); XL(path); return real_(rp_, uid, gid);
}
int lchown(const char *path, uid_t uid, gid_t gid) {
    REAL(lchown); XL(path); return real_(rp_, uid, gid);
}
int fchownat(int dirfd, const char *path, uid_t uid, gid_t gid, int flags) {
    REAL(fchownat); XL(path); return real_(dirfd, rp_, uid, gid, flags);
}
int truncate(const char *path, off_t length) {
    REAL(truncate); XL(path); return real_(rp_, length);
}
int utimensat(int dirfd, const char *path, const struct timespec times[2], int flags) {
    REAL(utimensat); XL(path); return real_(dirfd, rp_, times, flags);
}
int utimes(const char *path, const struct timeval times[2]) {
    REAL(utimes); XL(path); return real_(rp_, times);
}
int utime(const char *path, const struct utimbuf *times) {
    REAL(utime); XL(path); return real_(rp_, times);
}

/* ---- directory listing --------------------------------------------------- */

DIR *opendir(const char *path) {
    REAL(opendir); XL(path); return real_(rp_);
}
int scandir(const char *path, struct dirent ***namelist,
            int (*filter)(const struct dirent *),
            int (*compar)(const struct dirent **, const struct dirent **)) {
    REAL(scandir); XL(path); return real_(rp_, namelist, filter, compar);
}

/* ---- namespace mutation -------------------------------------------------- */

int mkdir(const char *path, mode_t mode) {
    REAL(mkdir); XL(path); return real_(rp_, mode);
}
int mkdirat(int dirfd, const char *path, mode_t mode) {
    REAL(mkdirat); XL(path); return real_(dirfd, rp_, mode);
}
int rmdir(const char *path) {
    REAL(rmdir); XL(path); return real_(rp_);
}
int unlink(const char *path) {
    REAL(unlink); XL(path); return real_(rp_);
}
int unlinkat(int dirfd, const char *path, int flags) {
    REAL(unlinkat); XL(path); return real_(dirfd, rp_, flags);
}
int remove(const char *path) {
    REAL(remove); XL(path); return real_(rp_);
}
int mkfifo(const char *path, mode_t mode) {
    REAL(mkfifo); XL(path); return real_(rp_, mode);
}
int mknod(const char *path, mode_t mode, dev_t dev) {
    REAL(mknod); XL(path); return real_(rp_, mode, dev);
}

/* rename / link / symlink translate BOTH paths. A symlink target under /vfs is
 * stored as its backing path so the kernel can follow it; readlink maps it back. */

int rename(const char *from, const char *to) {
    REAL(rename); XL2(from, to); return real_(ra_, rb_);
}
int renameat(int fromfd, const char *from, int tofd, const char *to) {
    REAL(renameat); XL2(from, to); return real_(fromfd, ra_, tofd, rb_);
}
int link(const char *from, const char *to) {
    REAL(link); XL2(from, to); return real_(ra_, rb_);
}
int linkat(int fromfd, const char *from, int tofd, const char *to, int flags) {
    REAL(linkat); XL2(from, to); return real_(fromfd, ra_, tofd, rb_, flags);
}
int symlink(const char *target, const char *linkpath) {
    REAL(symlink); XL2(target, linkpath); return real_(ra_, rb_);
}
int symlinkat(const char *target, int dirfd, const char *linkpath) {
    REAL(symlinkat); XL2(target, linkpath); return real_(ra_, dirfd, rb_);
}

/* ---- temp files: the template is rewritten in place by libc --------------- */

int mkstemp(char *template) {
    REAL(mkstemp);
    char tb[PATH_MAX];
    const char *rp = xlate(template, tb, sizeof tb);
    if (rp == template) return real_(template);
    int fd = real_(tb);
    if (fd >= 0) memcpy(template + strlen(template) - 6, tb + strlen(tb) - 6, 6);
    return fd;
}
char *mkdtemp(char *template) {
    REAL(mkdtemp);
    char tb[PATH_MAX];
    const char *rp = xlate(template, tb, sizeof tb);
    if (rp == template) return real_(template);
    if (!real_(tb)) return NULL;
    memcpy(template + strlen(template) - 6, tb + strlen(tb) - 6, 6);
    return template;
}

/* ---- cwd ------------------------------------------------------------------ */

int chdir(const char *path) {
    REAL(chdir); XL(path); return real_(rp_);
}

char *getcwd(char *buf, size_t size) {
    REAL(getcwd);
    char tmp[PATH_MAX];
    if (!real_(tmp, sizeof tmp)) return NULL;
    unxlate(tmp, sizeof tmp);
    size_t len = strlen(tmp) + 1;
    if (!buf) {
        if (size && len > size) { errno = ERANGE; return NULL; }
        return strdup(tmp);
    }
    if (len > size) { errno = ERANGE; return NULL; }
    memcpy(buf, tmp, len);
    return buf;
}

/* ---- paths handed back to the program are mapped to the virtual view ------ */

char *realpath(const char *path, char *resolved) {
    REAL(realpath); XL(path);
    char tmp[PATH_MAX];
    if (!real_(rp_, tmp)) return NULL;
    unxlate(tmp, sizeof tmp);
    if (!resolved) return strdup(tmp);
    memcpy(resolved, tmp, strlen(tmp) + 1);   /* resolved is PATH_MAX per POSIX */
    return resolved;
}

static ssize_t copy_link(const char *tmp, char *buf, size_t bufsz) {
    size_t len = strlen(tmp);
    if (len > bufsz) len = bufsz;
    memcpy(buf, tmp, len);
    return (ssize_t)len;
}

ssize_t readlink(const char *path, char *buf, size_t bufsz) {
    REAL(readlink); XL(path);
    char tmp[PATH_MAX];
    ssize_t n = real_(rp_, tmp, sizeof tmp - 1);
    if (n < 0) return n;
    tmp[n] = '\0';
    unxlate(tmp, sizeof tmp);
    return copy_link(tmp, buf, bufsz);
}
ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t bufsz) {
    REAL(readlinkat); XL(path);
    char tmp[PATH_MAX];
    ssize_t n = real_(dirfd, rp_, tmp, sizeof tmp - 1);
    if (n < 0) return n;
    tmp[n] = '\0';
    unxlate(tmp, sizeof tmp);
    return copy_link(tmp, buf, bufsz);
}

/* ---- raw syscall(2) ----------------------------------------------------------
 * Some runtimes bypass the libc wrappers: libuv (node) issues statx via
 * syscall(SYS_statx, ...). Translate the path argument for the single-path
 * syscalls. Two-path syscalls (renameat2, linkat, symlinkat) are reached through
 * their libc wrappers above in practice. */

long syscall(long n, ...) {
    REAL(syscall);
    long a[6];
    va_list ap; va_start(ap, n);
    for (int i = 0; i < 6; i++) a[i] = va_arg(ap, long);
    va_end(ap);

    int at = -1;   /* index of the path argument, if any */
    switch (n) {
#ifdef SYS_statx
    case SYS_statx:
#endif
#ifdef SYS_newfstatat
    case SYS_newfstatat:
#endif
#ifdef SYS_openat
    case SYS_openat:
#endif
#ifdef SYS_faccessat
    case SYS_faccessat:
#endif
#ifdef SYS_faccessat2
    case SYS_faccessat2:
#endif
#ifdef SYS_mkdirat
    case SYS_mkdirat:
#endif
#ifdef SYS_unlinkat
    case SYS_unlinkat:
#endif
#ifdef SYS_readlinkat
    case SYS_readlinkat:
#endif
#ifdef SYS_fchmodat
    case SYS_fchmodat:
#endif
#ifdef SYS_utimensat
    case SYS_utimensat:
#endif
        at = 1; break;
#ifdef SYS_open
    case SYS_open:
#endif
#ifdef SYS_stat
    case SYS_stat:
#endif
#ifdef SYS_lstat
    case SYS_lstat:
#endif
#ifdef SYS_access
    case SYS_access:
#endif
#ifdef SYS_mkdir
    case SYS_mkdir:
#endif
#ifdef SYS_rmdir
    case SYS_rmdir:
#endif
#ifdef SYS_unlink
    case SYS_unlink:
#endif
#ifdef SYS_chmod
    case SYS_chmod:
#endif
#ifdef SYS_chdir
    case SYS_chdir:
#endif
#ifdef SYS_truncate
    case SYS_truncate:
#endif
        at = 0; break;
    default: break;
    }

    char xb[PATH_MAX];
    if (at >= 0) a[at] = (long)xlate((const char *)a[at], xb, sizeof xb);
    return real_(n, a[0], a[1], a[2], a[3], a[4], a[5]);
}

/* ---- exec: binaries living under /vfs; LD_PRELOAD is inherited via env ---- */

int execve(const char *path, char *const argv[], char *const envp[]) {
    REAL(execve); XL(path); return real_(rp_, argv, envp);
}
int execv(const char *path, char *const argv[]) {
    REAL(execv); XL(path); return real_(rp_, argv);
}
int execvp(const char *file, char *const argv[]) {
    REAL(execvp); XL(file); return real_(rp_, argv);
}
