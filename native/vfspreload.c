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
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <sys/un.h>

/* ---- configuration (read once) ------------------------------------------ */

static const char *g_prefix;    /* virtual prefix, e.g. "/vfs"            */
static size_t      g_prefixlen;
static const char *g_backing;   /* real backing dir, e.g. "/tmp/vfsstore" */
static size_t      g_backinglen;
static const char *g_socket;    /* supervisor socket path, or NULL        */

/* libc entry points the shim itself needs, resolved past our own hooks */
static int (*real_close_)(int);

static void vfs_init(void) __attribute__((constructor));
static void vfs_init(void) {
    if (g_prefix) return;

    const char *p = getenv("VFS_PREFIX");
    g_prefix = (p && *p) ? p : "/vfs";
    g_prefixlen = strlen(g_prefix);

    const char *b = getenv("VFS_BACKING");
    g_backing = (b && *b) ? b : "/tmp/vfsstore";
    g_backinglen = strlen(g_backing);

    const char *s = getenv("VFS_SOCKET");
    g_socket = (s && *s) ? s : NULL;

    real_close_ = (int (*)(int))dlsym(RTLD_NEXT, "close");

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

/* XL: rp_ is the real path; vf_ is non-zero when p was a virtual path. */
#define XL(p) \
    const char *rp_; char xb_[PATH_MAX]; \
    rp_ = xlate((p), xb_, sizeof xb_); \
    int vf_ = (rp_ != (p)); (void)vf_

#define XL2(a, b) \
    char ab_[PATH_MAX], bb_[PATH_MAX]; \
    const char *ra_ = xlate((a), ab_, sizeof ab_); \
    const char *rb_ = xlate((b), bb_, sizeof bb_); \
    int va_ = (ra_ != (a)), vb_ = (rb_ != (b)); (void)va_; (void)vb_

#define REAL(name) \
    static typeof(&name) real_; \
    if (!real_) real_ = (typeof(&name))dlsym(RTLD_NEXT, #name)

/* ---- supervisor IPC ------------------------------------------------------ */

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int   g_ipc = -1;    /* connected socket, owned by g_ipc_pid */
static pid_t g_ipc_pid;

/* Append `s` to `out` as a JSON string body (no quotes), escaping as needed.
 * Returns the number of bytes written, or -1 if it would not fit. */
static ssize_t json_escape(const char *s, char *out, size_t cap) {
    size_t n = 0;
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        const char *esc = NULL;
        char u[8];
        switch (c) {
        case '"':  esc = "\\\""; break;
        case '\\': esc = "\\\\"; break;
        case '\n': esc = "\\n"; break;
        case '\r': esc = "\\r"; break;
        case '\t': esc = "\\t"; break;
        default:
            if (c < 0x20) { snprintf(u, sizeof u, "\\u%04x", c); esc = u; }
        }
        size_t len = esc ? strlen(esc) : 1;
        if (n + len >= cap) return -1;
        if (esc) memcpy(out + n, esc, len); else out[n] = (char)c;
        n += len;
    }
    if (n >= cap) return -1;
    out[n] = '\0';
    return (ssize_t)n;
}

/* Must be called with g_lock held. Returns the socket fd or -1 with errno. */
static int ipc_connect(void) {
    pid_t pid = getpid();
    if (g_ipc >= 0 && g_ipc_pid == pid) return g_ipc;
    if (g_ipc >= 0) { real_close_(g_ipc); g_ipc = -1; }   /* inherited across fork */

    struct sockaddr_un addr;
    if (strlen(g_socket) >= sizeof addr.sun_path) { errno = ENAMETOOLONG; return -1; }
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, g_socket);
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        int e = errno; real_close_(fd); errno = e; return -1;
    }
    g_ipc = fd; g_ipc_pid = pid;
    return fd;
}

/* Must be called with g_lock held. */
static void ipc_drop(void) {
    if (g_ipc >= 0) real_close_(g_ipc);
    g_ipc = -1;
}

/* One round trip: a request line out, a reply line back. 0 when the reply is
 * {"ok":true}; otherwise -1 with errno taken from the reply ("errno":N) or from
 * the transport failure. An unreachable supervisor is an error, not a silent
 * skip: the operator asked for the socket, so losing it must be loud. */
static int ipc_exchange(const char *req, size_t reqlen) {
    pthread_mutex_lock(&g_lock);
    int fd = ipc_connect();
    if (fd < 0) { int e = errno; pthread_mutex_unlock(&g_lock); errno = e; return -1; }

    size_t off = 0;
    while (off < reqlen) {
        ssize_t n = write(fd, req + off, reqlen - off);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ipc_drop(); pthread_mutex_unlock(&g_lock); errno = EIO; return -1; }
        off += (size_t)n;
    }

    char reply[512];
    size_t len = 0;
    for (;;) {
        ssize_t n = read(fd, reply + len, sizeof reply - 1 - len);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ipc_drop(); pthread_mutex_unlock(&g_lock); errno = EIO; return -1; }
        len += (size_t)n;
        if (memchr(reply, '\n', len)) break;
        if (len >= sizeof reply - 1) { ipc_drop(); pthread_mutex_unlock(&g_lock); errno = EIO; return -1; }
    }
    reply[len] = '\0';
    pthread_mutex_unlock(&g_lock);

    if (strstr(reply, "\"ok\":true")) return 0;
    const char *e = strstr(reply, "\"errno\":");
    errno = e ? atoi(e + 8) : EIO;
    if (errno <= 0) errno = EIO;
    return -1;
}

/* Notify the supervisor about `op` on virtual path `p` (and `p2` for rename).
 * `flags` are the open(2) flags for "open". No-op (0) without VFS_SOCKET. */
static int notify(const char *op, const char *p, const char *p2, int flags) {
    if (!g_socket) return 0;
    char e1[2 * PATH_MAX], e2[2 * PATH_MAX], req[4 * PATH_MAX + 128];
    if (json_escape(p, e1, sizeof e1) < 0) { errno = ENAMETOOLONG; return -1; }
    int n;
    if (p2) {
        if (json_escape(p2, e2, sizeof e2) < 0) { errno = ENAMETOOLONG; return -1; }
        n = snprintf(req, sizeof req, "{\"op\":\"%s\",\"from\":\"%s\",\"to\":\"%s\"}\n", op, e1, e2);
    } else if (strcmp(op, "open") == 0) {
        n = snprintf(req, sizeof req, "{\"op\":\"%s\",\"path\":\"%s\",\"flags\":%d}\n", op, e1, flags);
    } else {
        n = snprintf(req, sizeof req, "{\"op\":\"%s\",\"path\":\"%s\"}\n", op, e1);
    }
    if (n < 0 || (size_t)n >= sizeof req) { errno = ENAMETOOLONG; return -1; }
    int saved = errno;
    int r = ipc_exchange(req, (size_t)n);
    if (r == 0) errno = saved;
    return r;
}

/* ---- descriptors opened for writing ---------------------------------------
 * The supervisor is told "open" when a virtual file is opened writable and
 * "flush" when the last reference is closed or fsync'd, so it can persist the
 * backing file. The table maps fd -> virtual path for those descriptors. */

#define FD_MAX 65536
static char *g_fdpath[FD_MAX];

static void fd_track(int fd, const char *vpath) {
    if (fd < 0 || fd >= FD_MAX) return;
    char *copy = strdup(vpath);
    pthread_mutex_lock(&g_lock);
    free(g_fdpath[fd]);
    g_fdpath[fd] = copy;
    pthread_mutex_unlock(&g_lock);
}

/* Removes and returns the tracked path (caller frees), or NULL. */
static char *fd_take(int fd) {
    if (fd < 0 || fd >= FD_MAX) return NULL;
    pthread_mutex_lock(&g_lock);
    char *p = g_fdpath[fd];
    g_fdpath[fd] = NULL;
    pthread_mutex_unlock(&g_lock);
    return p;
}

/* Copies the tracking of `from` onto `to` (dup family). */
static void fd_copy(int from, int to) {
    if (from < 0 || from >= FD_MAX || to < 0 || to >= FD_MAX || from == to) return;
    pthread_mutex_lock(&g_lock);
    char *p = g_fdpath[from] ? strdup(g_fdpath[from]) : NULL;
    free(g_fdpath[to]);
    g_fdpath[to] = p;
    pthread_mutex_unlock(&g_lock);
}

static int is_write(int flags) {
    return (flags & O_ACCMODE) != O_RDONLY || (flags & (O_CREAT | O_TRUNC));
}

/* Before opening virtual path `vp`: make sure the backing file is populated.
 * A missing object is only an error when the caller is not creating. */
static int pre_open(const char *vp, int flags) {
    if (flags & O_TRUNC) return 0;
    if (notify("fetch", vp, NULL, 0) == 0) return 0;
    if ((flags & O_CREAT) && errno == ENOENT) return 0;
    return -1;
}

/* After a successful open of virtual path `vp` as `fd`: register writers. */
static int post_open(int fd, const char *vp, int flags) {
    if (fd < 0 || !is_write(flags)) return fd;
    if (notify("open", vp, NULL, flags) < 0) {
        int e = errno; real_close_(fd); errno = e; return -1;
    }
    fd_track(fd, vp);
    return fd;
}

/* On the last close (or an fsync) of a writer: ask the supervisor to persist. */
static int flush_fd(int fd, int take) {
    char *vp = take ? fd_take(fd) : NULL;
    if (!take) {
        pthread_mutex_lock(&g_lock);
        vp = (fd >= 0 && fd < FD_MAX && g_fdpath[fd]) ? strdup(g_fdpath[fd]) : NULL;
        pthread_mutex_unlock(&g_lock);
    }
    if (!vp) return 0;
    int r = notify("flush", vp, NULL, 0);
    free(vp);
    return r;
}
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
    int r = real_close_(fd);
    int f = flush_fd(fd, 1);
    if (f < 0) return -1;
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
