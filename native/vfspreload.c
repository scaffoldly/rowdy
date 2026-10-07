/*
 * vfspreload.c — a userspace VFS via LD_PRELOAD libc interposition.
 *
 * The sandbox denies every kernel-mediated VFS primitive (/dev/fuse, mount(2),
 * namespaces, ptrace, seccomp-notify — all EPERM/ENOENT). The one path that
 * survives is intercepting libc's path entry points in-process. This shim turns
 * a virtual prefix (VFS_PREFIX, default "/vfs") into a full, writable, persistent
 * filesystem backed by a real directory (VFS_BACKING, default "/tmp/vfsstore").
 * Several prefixes can be mounted at once with VFS_MOUNTS.
 *
 * Layout, each layer depending only on the one below it:
 *   vfspreload.c     interposition: the libc symbols and their arguments
 *   vfs_core.h       core: mount table, path translation, open-file table
 *   vfs_transport.h  transport: the client for the supervisor protocol
 *
 * It is a genuine filesystem surface: create, read, write, stat, list, mkdir,
 * rename, chmod, delete all work, because each path-based call is translated and
 * delegated to the real libc against the backing store. Calls that hand a path
 * back to the program (getcwd, realpath, readlink) are translated in reverse so
 * the backing directory never leaks into the program's view.
 *
 * Supervisor socket (VFS_SOCKET): when set, the shim tells the process that
 * launched it what is about to happen to the virtual tree so that process can
 * populate the backing directory first (stat/fetch/list) and persist it after
 * (open/flush/mkdir/unlink/rename). Requests and replies are one JSON object
 * per line over a unix-domain stream socket; only paths, flags and metadata
 * cross it, never file contents. See DISCLOSURE for the protocol. With no
 * VFS_SOCKET the shim is a plain local-directory overlay.
 *
 * musl note: within libc, one function calling another (fopen->open,
 * scandir->opendir, remove->unlink, fclose->close) binds internally and does
 * NOT route through a preloaded symbol. So we must interpose every PUBLIC
 * entry point the calling program uses directly, not rely on one wrapper
 * covering another. That is exactly what this file does.
 *
 * Scope / ceiling (inherent to the preload model):
 *   - only processes started with this .so in LD_PRELOAD see the VFS;
 *   - only dynamically-linked musl callers that invoke these libc symbols;
 *   - it is not a kernel mountpoint — unrelated processes cannot see /vfs;
 *   - no mmap of virtual files, no nftw/glob/posix_spawn translation (yet);
 *   - only absolute VFS_PREFIX paths are reported to the supervisor; relative
 *     paths after chdir() resolve locally.
 *
 * Build:  gcc -shared -fPIC vfspreload.c -o vfspreload.so
 * Run:    LD_PRELOAD=/usr/local/lib/rowdy/vfspreload.so \
 *         VFS_PREFIX=/vfs VFS_BACKING=/tmp/vfsstore [VFS_SOCKET=/tmp/rowdy/vfs.sock] <program>
 *   or    VFS_MOUNTS=/a=/tmp/store/a:/b=/tmp/store/b   (prefix=backing, ':'-separated)
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
#include <pthread.h>
#include <utime.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <spawn.h>
#include <sys/xattr.h>


#include "vfs_transport.h"
#include "vfs_core.h"

/* ---- open family (variadic mode) ----------------------------------------- */

int open64(const char *path, int flags, ...) {
    REAL(open64);
    if (!real_) {
        // Fallback if no open64 in libc
        int (*fallback)(const char *, int, ...) = dlsym(RTLD_NEXT, "open");
        mode_t mode = 0;
        if (flags & (O_CREAT | O_TMPFILE)) {
            va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
        }
        XL(path);
        if (vf_ && pre_open(path, flags) < 0) return -1;
        int fd = fallback(rp_, flags, mode);
        if (vf_) return post_open(fd, path, flags);
        return fd;
    }
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
    }
    XL(path);
    if (vf_ && pre_open(path, flags) < 0) return -1;
    int fd = real_(rp_, flags, mode);
    if (vf_) return post_open(fd, path, flags);
    return fd;
}

int open(const char *path, int flags, ...) {
    REAL(open);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
    }
    XL(path);
    if (vf_ && pre_open(path, flags) < 0) return -1;
    int fd = real_(rp_, flags, mode);
    if (vf_) return post_open(fd, path, flags);
    return fd;
}

int openat64(int dirfd, const char *path, int flags, ...) {
    REAL(openat64);
    if (!real_) {
        int (*fallback)(int, const char *, int, ...) = dlsym(RTLD_NEXT, "openat");
        mode_t mode = 0;
        if (flags & (O_CREAT | O_TMPFILE)) {
            va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
        }
        XL(path);
        if (vf_ && pre_open(path, flags) < 0) return -1;
        int fd = fallback(dirfd, rp_, flags, mode);
        if (vf_) return post_open(fd, path, flags);
        return fd;
    }
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
    }
    XL(path);
    if (vf_ && pre_open(path, flags) < 0) return -1;
    int fd = real_(dirfd, rp_, flags, mode);
    if (vf_) return post_open(fd, path, flags);
    return fd;
}

int openat(int dirfd, const char *path, int flags, ...) {
    REAL(openat);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap);
    }
    XL(path);
    if (vf_ && pre_open(path, flags) < 0) return -1;
    int fd = real_(dirfd, rp_, flags, mode);
    if (vf_) return post_open(fd, path, flags);
    return fd;
}

int creat(const char *path, mode_t mode) {
    REAL(creat); XL(path);
    int flags = O_CREAT | O_WRONLY | O_TRUNC;
    if (vf_ && pre_open(path, flags) < 0) return -1;
    int fd = real_(rp_, mode);
    if (vf_) return post_open(fd, path, flags);
    return fd;
}

/* ---- stdio (musl binds fopen->open internally) --------------------------- */

static int mode_to_flags(const char *mode) {
    int flags = 0;
    if (strchr(mode, '+')) flags |= O_RDWR;
    else if (mode[0] == 'r') flags |= O_RDONLY;
    else if (mode[0] == 'w' || mode[0] == 'a') flags |= O_WRONLY;

    if (mode[0] == 'w') flags |= O_CREAT | O_TRUNC;
    if (mode[0] == 'a') flags |= O_CREAT | O_APPEND;
    return flags;
}

FILE *fopen(const char *path, const char *mode) {
    REAL(fopen); XL(path);
    int flags = mode_to_flags(mode);
    if (vf_ && pre_open(path, flags) < 0) return NULL;
    FILE *f = real_(rp_, mode);
    if (f && vf_ && post_open(fileno(f), path, flags) < 0) return NULL;
    return f;
}
FILE *freopen(const char *path, const char *mode, FILE *stream) {
    REAL(freopen); XL(path);
    int flags = mode_to_flags(mode);
    if (vf_ && pre_open(path, flags) < 0) return NULL;
    FILE *f = real_(rp_, mode, stream);
    if (f && vf_ && post_open(fileno(f), path, flags) < 0) return NULL;
    return f;
}

/* ---- metadata ------------------------------------------------------------ */

int stat(const char *path, struct stat *st) {
    REAL(stat);  XL(path);  return real_(rp_, st);
}
int lstat(const char *path, struct stat *st) {
    REAL(lstat); XL(path);  return real_(rp_, st);
}
int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    REAL(fstatat); XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(dirfd, rp_, st, flags);
}
int access(const char *path, int mode) {
    REAL(access); XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(rp_, mode);
}
int faccessat(int dirfd, const char *path, int mode, int flags) {
    REAL(faccessat); XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(dirfd, rp_, mode, flags);
}
int statx(int dirfd, const char *path, int flags, unsigned mask, struct statx *buf) {
    REAL(statx); XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(dirfd, rp_, flags, mask, buf);
}
int statfs(const char *path, struct statfs *buf) {
    REAL(statfs); XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(rp_, buf);
}
int statvfs(const char *path, struct statvfs *buf) {
    REAL(statvfs); XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(rp_, buf);
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
    REAL(truncate); XL(path);
    int r = real_(rp_, length);
    if (r == 0 && vf_ && notify("flush", path, NULL, 0) < 0) return -1;
    return r;
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
    REAL(opendir); XL(path);
    if (vf_ && notify("list", path, NULL, 0) < 0) return NULL;
    return real_(rp_);
}
int scandir(const char *path, struct dirent ***namelist,
            int (*filter)(const struct dirent *),
            int (*compar)(const struct dirent **, const struct dirent **)) {
    REAL(scandir); XL(path);
    if (vf_ && notify("list", path, NULL, 0) < 0) return -1;
    return real_(rp_, namelist, filter, compar);
}

/* ---- namespace mutation -------------------------------------------------- */

int mkdir(const char *path, mode_t mode) {
    REAL(mkdir); XL(path);
    int r = real_(rp_, mode);
    if (r == 0 && vf_ && notify("mkdir", path, NULL, 0) < 0) return -1;
    return r;
}
int mkdirat(int dirfd, const char *path, mode_t mode) {
    REAL(mkdirat); XL(path);
    int r = real_(dirfd, rp_, mode);
    if (r == 0 && vf_ && notify("mkdir", path, NULL, 0) < 0) return -1;
    return r;
}
int rmdir(const char *path) {
    REAL(rmdir); XL(path);
    int r = real_(rp_);
    if (r == 0 && vf_ && notify("unlink", path, NULL, 0) < 0) return -1;
    return r;
}
int unlink(const char *path) {
    REAL(unlink); XL(path);
    int r = real_(rp_);
    if (r == 0 && vf_ && notify("unlink", path, NULL, 0) < 0) return -1;
    return r;
}
int unlinkat(int dirfd, const char *path, int flags) {
    REAL(unlinkat); XL(path);
    int r = real_(dirfd, rp_, flags);
    if (r == 0 && vf_ && notify("unlink", path, NULL, 0) < 0) return -1;
    return r;
}
int remove(const char *path) {
    REAL(remove); XL(path);
    int r = real_(rp_);
    if (r == 0 && vf_ && notify("unlink", path, NULL, 0) < 0) return -1;
    return r;
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
    REAL(rename); XL2(from, to);
    int r = real_(ra_, rb_);
    if (r == 0 && (va_ || vb_) && notify("rename", from, to, 0) < 0) return -1;
    return r;
}
int renameat(int fromfd, const char *from, int tofd, const char *to) {
    REAL(renameat); XL2(from, to);
    int r = real_(fromfd, ra_, tofd, rb_);
    if (r == 0 && (va_ || vb_) && notify("rename", from, to, 0) < 0) return -1;
    return r;
}
int link(const char *from, const char *to) {
    REAL(link); XL2(from, to);
    int r = real_(ra_, rb_);
    if (r == 0 && vb_ && notify("flush", to, NULL, 0) < 0) return -1;
    return r;
}
int linkat(int fromfd, const char *from, int tofd, const char *to, int flags) {
    REAL(linkat); XL2(from, to);
    int r = real_(fromfd, ra_, tofd, rb_, flags);
    if (r == 0 && vb_ && notify("flush", to, NULL, 0) < 0) return -1;
    return r;
}
int symlink(const char *target, const char *linkpath) {
    REAL(symlink); XL2(target, linkpath);
    int r = real_(ra_, rb_);
    if (r == 0 && vb_ && notify("flush", linkpath, NULL, 0) < 0) return -1;
    return r;
}
int symlinkat(const char *target, int dirfd, const char *linkpath) {
    REAL(symlinkat); XL2(target, linkpath);
    int r = real_(ra_, dirfd, rb_);
    if (r == 0 && vb_ && notify("flush", linkpath, NULL, 0) < 0) return -1;
    return r;
}

/* ---- temp files: the template is rewritten in place by libc --------------- */

int mkstemp(char *template) {
    REAL(mkstemp);
    char tb[PATH_MAX];
    const char *rp = xlate(template, tb, sizeof tb);
    int vf_ = (rp != template);
    if (vf_ && pre_open(template, O_RDWR | O_CREAT) < 0) return -1;
    int fd = real_(rp == template ? template : tb);
    if (fd >= 0 && rp != template) memcpy(template + strlen(template) - 6, tb + strlen(tb) - 6, 6);
    if (vf_ && fd >= 0) return post_open(fd, template, O_RDWR | O_CREAT);
    return fd;
}
char *mkdtemp(char *template) {
    REAL(mkdtemp);
    char tb[PATH_MAX];
    const char *rp = xlate(template, tb, sizeof tb);
    int vf_ = (rp != template);
    if (rp == template) return real_(template);
    if (!real_(tb)) return NULL;
    memcpy(template + strlen(template) - 6, tb + strlen(tb) - 6, 6);
    if (vf_ && notify("mkdir", template, NULL, 0) < 0) return NULL;
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
    if (vf_ && notify("stat", path, NULL, 0) < 0) return NULL;
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
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    char tmp[PATH_MAX];
    ssize_t n = real_(rp_, tmp, sizeof tmp - 1);
    if (n < 0) return n;
    tmp[n] = '\0';
    unxlate(tmp, sizeof tmp);
    return copy_link(tmp, buf, bufsz);
}
ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t bufsz) {
    REAL(readlinkat); XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    char tmp[PATH_MAX];
    ssize_t n = real_(dirfd, rp_, tmp, sizeof tmp - 1);
    if (n < 0) return n;
    tmp[n] = '\0';
    unxlate(tmp, sizeof tmp);
    return copy_link(tmp, buf, bufsz);
}


/* ---- new hooks for fd flushing ------------------------------------------- */

int close(int fd) {
    if (!real_close_) vfs_init();
    /* Closing drops any advisory lock the program still held: end the lease too. */
    int l = fd_wlocked(fd) ? lock_transition(fd, F_UNLCK) : 0;
    int r = real_close_(fd);
    int f = flush_fd(fd, 1);
    if (f < 0 || l < 0) return -1;
    return r;
}

int fsync(int fd) {
    REAL(fsync);
    int r = real_(fd);
    if (r == 0 && flush_fd(fd, 0) < 0) return -1;
    return r;
}

int fdatasync(int fd) {
    REAL(fdatasync);
    int r = real_(fd);
    if (r == 0 && flush_fd(fd, 0) < 0) return -1;
    return r;
}

int dup(int oldfd) {
    REAL(dup);
    int newfd = real_(oldfd);
    if (newfd >= 0) fd_copy(oldfd, newfd);
    return newfd;
}

int dup2(int oldfd, int newfd) {
    REAL(dup2);
    int r = real_(oldfd, newfd);
    if (r >= 0) fd_copy(oldfd, r);
    return r;
}

int dup3(int oldfd, int newfd, int flags) {
    REAL(dup3);
    int r = real_(oldfd, newfd, flags);
    if (r >= 0) fd_copy(oldfd, r);
    return r;
}

int fclose(FILE *f) {
    REAL(fclose);
    int fd = f ? fileno(f) : -1;
    int r = real_(f);
    if (fd >= 0 && flush_fd(fd, 1) < 0) return EOF;
    return r;
}

/* ---- advisory locks ----------------------------------------------------------
 * The lock is still taken locally (the real call runs), so behaviour within one
 * process is unchanged; the supervisor is additionally told about transitions
 * on descriptors under VFS_PREFIX. A "lock" refused with EAGAIN fails the call
 * exactly like a contended POSIX lock, so callers retry as they already do. */

int fcntl(int fd, int cmd, ...) {
    REAL(fcntl);
    va_list ap; va_start(ap, cmd);
    int lockcmd = cmd == F_SETLK || cmd == F_SETLKW
#ifdef F_OFD_SETLK
        || cmd == F_OFD_SETLK || cmd == F_OFD_SETLKW
#endif
        ;
    if (lockcmd) {
        struct flock *fl = va_arg(ap, struct flock *);
        va_end(ap);
        if (fl && lock_transition(fd, fl->l_type) < 0) return -1;
        return real_(fd, cmd, fl);
    }
    void *arg = va_arg(ap, void *);
    va_end(ap);
    return real_(fd, cmd, arg);
}

int flock(int fd, int op) {
    REAL(flock);
    int kind = op & ~LOCK_NB;
    int type = kind == LOCK_EX ? F_WRLCK : kind == LOCK_SH ? F_RDLCK : kind == LOCK_UN ? F_UNLCK : -1;
    if (type >= 0 && lock_transition(fd, type) < 0) return -1;
    return real_(fd, op);
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
    const char *orig = NULL;
    int vf_ = 0;
    if (at >= 0) {
        orig = (const char *)a[at];
        const char *rp = xlate(orig, xb, sizeof xb);
        vf_ = (rp != orig);
        if (vf_) {
            switch (n) {
#ifdef SYS_statx
            case SYS_statx:
#endif
#ifdef SYS_newfstatat
            case SYS_newfstatat:
#endif
#ifdef SYS_faccessat
            case SYS_faccessat:
#endif
#ifdef SYS_faccessat2
            case SYS_faccessat2:
#endif
#ifdef SYS_readlinkat
            case SYS_readlinkat:
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
                if (notify("stat", orig, NULL, 0) < 0) return -1;
                break;
#ifdef SYS_openat
            case SYS_openat:
                if (pre_open(orig, (int)a[2]) < 0) return -1;
                break;
#endif
#ifdef SYS_open
            case SYS_open:
                if (pre_open(orig, (int)a[1]) < 0) return -1;
                break;
#endif
            }
        }
        a[at] = (long)rp;
    }

    long r = real_(n, a[0], a[1], a[2], a[3], a[4], a[5]);

#ifdef SYS_close
    if (n == SYS_close) {
        int f = flush_fd((int)a[0], 1);
        if (f < 0) return -1;
        return r;
    }
#endif

    if (vf_) {
        switch (n) {
#ifdef SYS_openat
        case SYS_openat:
            if (r >= 0) r = post_open((int)r, orig, (int)a[2]);
            break;
#endif
#ifdef SYS_open
        case SYS_open:
            if (r >= 0) r = post_open((int)r, orig, (int)a[1]);
            break;
#endif
#ifdef SYS_mkdirat
        case SYS_mkdirat:
#endif
#ifdef SYS_mkdir
        case SYS_mkdir:
#endif
            if (r == 0 && notify("mkdir", orig, NULL, 0) < 0) return -1;
            break;
#ifdef SYS_unlinkat
        case SYS_unlinkat:
#endif
#ifdef SYS_unlink
        case SYS_unlink:
#endif
#ifdef SYS_rmdir
        case SYS_rmdir:
#endif
            if (r == 0 && notify("unlink", orig, NULL, 0) < 0) return -1;
            break;
        }
    }
    return r;
}

/* ---- exec: binaries living under /vfs; LD_PRELOAD is inherited via env ---- */

int execve(const char *path, char *const argv[], char *const envp[]) {
    REAL(execve); XL(path);
    if (vf_ && notify("fetch", path, NULL, 0) < 0) return -1;
    return real_(rp_, argv, envp);
}
int execv(const char *path, char *const argv[]) {
    REAL(execv); XL(path);
    if (vf_ && notify("fetch", path, NULL, 0) < 0) return -1;
    return real_(rp_, argv);
}
int execvp(const char *file, char *const argv[]) {
    REAL(execvp); XL(file);
    if (vf_ && notify("fetch", file, NULL, 0) < 0) return -1;
    return real_(rp_, argv);
}

/* ---- glibc's alternative entry points ----------------------------------------
 * One object serves musl and glibc (ADR 0003). glibc programs reach some calls under other names:
 * the LFS "64" names, the _FORTIFY_SOURCE entry points and renameat2. On LP64 (the only targets
 * built) the 64 types are the plain types, so each name delegates to the plain hook. glibc-only
 * functions are only ever looked up with dlsym: a link-time reference would stop musl loading the
 * object. */

_Static_assert(sizeof(struct stat64) == sizeof(struct stat), "LP64: struct stat64 is struct stat");
_Static_assert(sizeof(struct statfs64) == sizeof(struct statfs), "LP64: statfs64 is statfs");
_Static_assert(sizeof(struct statvfs64) == sizeof(struct statvfs), "LP64: statvfs64 is statvfs");
_Static_assert(sizeof(struct dirent64) == sizeof(struct dirent), "LP64: dirent64 is dirent");
_Static_assert(sizeof(off64_t) == sizeof(off_t), "LP64: off64_t is off_t");

int stat64(const char *path, struct stat64 *st) { return stat(path, (struct stat *)st); }
int lstat64(const char *path, struct stat64 *st) { return lstat(path, (struct stat *)st); }
int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags) {
    return fstatat(dirfd, path, (struct stat *)st, flags);
}
int statfs64(const char *path, struct statfs64 *buf) { return statfs(path, (struct statfs *)buf); }
int statvfs64(const char *path, struct statvfs64 *buf) { return statvfs(path, (struct statvfs *)buf); }
int truncate64(const char *path, off64_t length) { return truncate(path, (off_t)length); }
int creat64(const char *path, mode_t mode) { return creat(path, mode); }
FILE *fopen64(const char *path, const char *mode) { return fopen(path, mode); }
FILE *freopen64(const char *path, const char *mode, FILE *stream) { return freopen(path, mode, stream); }
int scandir64(const char *path, struct dirent64 ***namelist,
              int (*filter)(const struct dirent64 *),
              int (*compar)(const struct dirent64 **, const struct dirent64 **)) {
    return scandir(path, (struct dirent ***)namelist,
                   (int (*)(const struct dirent *))filter,
                   (int (*)(const struct dirent **, const struct dirent **))compar);
}
int mkstemp64(char *template) { return mkstemp(template); }

/* Binaries built against glibc < 2.33 (official node builds among them) call stat through these
 * versioned wrappers. Below 2.33 they are the real functions (there is no exported stat), so the
 * same name is called through; from 2.33 on they exist only for such binaries, and the plain hooks
 * stand in. */
typedef int (*xstat_fn)(int, const char *, struct stat *);
typedef int (*fxstatat_fn)(int, int, const char *, struct stat *, int);

int __xstat(int ver, const char *path, struct stat *st) {
    REAL_T(__xstat, xstat_fn);
    if (!real_) return stat(path, st);
    XL(path); return real_(ver, rp_, st);
}
int __xstat64(int ver, const char *path, struct stat64 *st) {
    REAL_T(__xstat64, xstat_fn);
    if (!real_) return stat(path, (struct stat *)st);
    XL(path); return real_(ver, rp_, (struct stat *)st);
}
int __lxstat(int ver, const char *path, struct stat *st) {
    REAL_T(__lxstat, xstat_fn);
    if (!real_) return lstat(path, st);
    XL(path); return real_(ver, rp_, st);
}
int __lxstat64(int ver, const char *path, struct stat64 *st) {
    REAL_T(__lxstat64, xstat_fn);
    if (!real_) return lstat(path, (struct stat *)st);
    XL(path); return real_(ver, rp_, (struct stat *)st);
}
int __fxstatat(int ver, int dirfd, const char *path, struct stat *st, int flags) {
    REAL_T(__fxstatat, fxstatat_fn);
    if (!real_) return fstatat(dirfd, path, st, flags);
    XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(ver, dirfd, rp_, st, flags);
}
int __fxstatat64(int ver, int dirfd, const char *path, struct stat64 *st, int flags) {
    REAL_T(__fxstatat64, fxstatat_fn);
    if (!real_) return fstatat(dirfd, path, (struct stat *)st, flags);
    XL(path);
    if (vf_ && notify("stat", path, NULL, 0) < 0) return -1;
    return real_(ver, dirfd, rp_, (struct stat *)st, flags);
}

/* glibc 2.28+ binds fcntl to fcntl64 in programs built with _FILE_OFFSET_BITS=64, such as SQLite,
 * so advisory locks arrive here. */
int fcntl64(int fd, int cmd, ...) {
    va_list ap; va_start(ap, cmd);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    return fcntl(fd, cmd, arg);
}

/* Fortify. glibc calls these only for opens without O_CREAT/O_TMPFILE, so there is no mode. */
int __open_2(const char *path, int flags) { return open(path, flags); }
int __open64_2(const char *path, int flags) { return open64(path, flags); }
int __openat_2(int dirfd, const char *path, int flags) { return openat(dirfd, path, flags); }
int __openat64_2(int dirfd, const char *path, int flags) { return openat64(dirfd, path, flags); }

/* The _chk entry points carry the caller's real buffer size; an overflow aborts as glibc would. */
static void chk_fail(void) {
    void (*fail)(void) = (void (*)(void))dlsym(RTLD_DEFAULT, "__chk_fail");
    if (fail) fail();
    abort();
}
char *__realpath_chk(const char *path, char *resolved, size_t resolvedlen) {
    if (resolved && resolvedlen < PATH_MAX) chk_fail();
    return realpath(path, resolved);
}
char *__getcwd_chk(char *buf, size_t size, size_t buflen) {
    if (size > buflen) chk_fail();
    return getcwd(buf, size);
}
ssize_t __readlink_chk(const char *path, char *buf, size_t len, size_t buflen) {
    if (len > buflen) chk_fail();
    return readlink(path, buf, len);
}
ssize_t __readlinkat_chk(int dirfd, const char *path, char *buf, size_t len, size_t buflen) {
    if (len > buflen) chk_fail();
    return readlinkat(dirfd, path, buf, len);
}

/* renameat2: the supervisor's rename is one-way, so EXCHANGE/WHITEOUT on a VFS path is refused. */
int renameat2(int fromfd, const char *from, int tofd, const char *to, unsigned int flags) {
    REAL(renameat2);
    if (!real_) {
        if (flags) { errno = ENOSYS; return -1; }
        return renameat(fromfd, from, tofd, to);
    }
    XL2(from, to);
    if ((va_ || vb_) && (flags & ~(unsigned int)RENAME_NOREPLACE)) { errno = EINVAL; return -1; }
    int r = real_(fromfd, ra_, tofd, rb_, flags);
    if (r == 0 && (va_ || vb_) && notify("rename", from, to, 0) < 0) return -1;
    return r;
}

/* ---- hooks both libcs use ------------------------------------------------------ */

/* Extended attributes live on the backing file; they are not carried to S3. */
#define XATTR_STAT(path) if (vf_ && notify("stat", (path), NULL, 0) < 0) return -1
#define REAL_OR_ENOSYS(name) REAL(name); if (!real_) { errno = ENOSYS; return -1; }

ssize_t getxattr(const char *path, const char *name, void *value, size_t size) {
    REAL_OR_ENOSYS(getxattr); XL(path); XATTR_STAT(path); return real_(rp_, name, value, size);
}
ssize_t lgetxattr(const char *path, const char *name, void *value, size_t size) {
    REAL_OR_ENOSYS(lgetxattr); XL(path); XATTR_STAT(path); return real_(rp_, name, value, size);
}
int setxattr(const char *path, const char *name, const void *value, size_t size, int flags) {
    REAL_OR_ENOSYS(setxattr); XL(path); XATTR_STAT(path); return real_(rp_, name, value, size, flags);
}
int lsetxattr(const char *path, const char *name, const void *value, size_t size, int flags) {
    REAL_OR_ENOSYS(lsetxattr); XL(path); XATTR_STAT(path); return real_(rp_, name, value, size, flags);
}
ssize_t listxattr(const char *path, char *list, size_t size) {
    REAL_OR_ENOSYS(listxattr); XL(path); XATTR_STAT(path); return real_(rp_, list, size);
}
ssize_t llistxattr(const char *path, char *list, size_t size) {
    REAL_OR_ENOSYS(llistxattr); XL(path); XATTR_STAT(path); return real_(rp_, list, size);
}
int removexattr(const char *path, const char *name) {
    REAL_OR_ENOSYS(removexattr); XL(path); XATTR_STAT(path); return real_(rp_, name);
}
int lremovexattr(const char *path, const char *name) {
    REAL_OR_ENOSYS(lremovexattr); XL(path); XATTR_STAT(path); return real_(rp_, name);
}

typedef int (*scandirat_fn)(int, const char *, struct dirent ***,
                            int (*)(const struct dirent *),
                            int (*)(const struct dirent **, const struct dirent **));
int scandirat(int dirfd, const char *path, struct dirent ***namelist,
              int (*filter)(const struct dirent *),
              int (*compar)(const struct dirent **, const struct dirent **)) {
    REAL_T(scandirat, scandirat_fn);
    if (!real_) { errno = ENOSYS; return -1; }
    XL(path);
    if (vf_ && notify("list", path, NULL, 0) < 0) return -1;
    return real_(dirfd, rp_, namelist, filter, compar);
}
int scandirat64(int dirfd, const char *path, struct dirent64 ***namelist,
                int (*filter)(const struct dirent64 *),
                int (*compar)(const struct dirent64 **, const struct dirent64 **)) {
    return scandirat(dirfd, path, (struct dirent ***)namelist,
                     (int (*)(const struct dirent *))filter,
                     (int (*)(const struct dirent **, const struct dirent **))compar);
}

/* glibc's posix_spawn execs internally, past the execve hook. Errors are returned, not set. */
int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
    REAL(posix_spawn);
    if (!real_) return ENOSYS;
    XL(path);
    if (vf_ && notify("fetch", path, NULL, 0) < 0) return errno;
    return real_(pid, rp_, actions, attr, argv, envp);
}
int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
    REAL(posix_spawnp);
    if (!real_) return ENOSYS;
    XL(file);
    if (vf_ && notify("fetch", file, NULL, 0) < 0) return errno;
    return real_(pid, rp_, actions, attr, argv, envp);
}
