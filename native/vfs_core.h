/*
 * vfs_core.h — the filesystem's own state: what is mounted where, how a path
 * maps into a mount, and which descriptors are open on virtual files.
 *
 * Depends on vfs_transport.h and on nothing above it. The interposition layer
 * uses only what is declared here.
 */
#ifndef VFS_CORE_H
#define VFS_CORE_H

/* ---- mount table (read once) ---------------------------------------------- */

/* A virtual prefix (e.g. "/vfs") served from a real directory (e.g.
 * "/tmp/vfsstore"). Neither ends in '/'. */
struct vfs_mount {
    char  *prefix;
    size_t prefixlen;
    char  *backing;
    size_t backinglen;
};

#define MOUNT_MAX 16
static struct vfs_mount g_mounts[MOUNT_MAX];
static int g_nmounts;
static int g_init;

static void mount_add(const char *prefix, size_t plen, const char *backing, size_t blen) {
    if (g_nmounts >= MOUNT_MAX || plen == 0 || blen == 0) return;
    struct vfs_mount *m = &g_mounts[g_nmounts];
    m->prefix = strndup(prefix, plen);
    m->backing = strndup(backing, blen);
    if (!m->prefix || !m->backing) return;
    m->prefixlen = plen;
    m->backinglen = blen;
    g_nmounts++;
}

/* mkdir -p, best effort, with libc's mkdir resolved past our hook. */
static void mkdir_p(int (*real_mkdir)(const char *, mode_t), const char *dir) {
    char buf[PATH_MAX];
    size_t len = strlen(dir);
    if (len == 0 || len >= sizeof buf) return;
    memcpy(buf, dir, len + 1);
    for (char *p = buf + 1; *p; p++) {
        if (*p != '/') continue;
        *p = '\0';
        real_mkdir(buf, 0777);
        *p = '/';
    }
    real_mkdir(buf, 0777);
}

static void vfs_init(void) __attribute__((constructor));
static void vfs_init(void) {
    if (g_init) return;
    g_init = 1;

    transport_init();

    /* VFS_MOUNTS: "prefix=backing" entries separated by ':'. The split is at the
     * last '=' of an entry, so a prefix may contain one. */
    const char *spec = getenv("VFS_MOUNTS");
    while (spec && *spec) {
        const char *end = strchr(spec, ':');
        if (!end) end = spec + strlen(spec);
        const char *eq = NULL;
        for (const char *q = spec; q < end; q++) if (*q == '=') eq = q;
        if (eq) mount_add(spec, (size_t)(eq - spec), eq + 1, (size_t)(end - eq - 1));
        spec = *end ? end + 1 : end;
    }

    /* Without it: the single mount of VFS_PREFIX on VFS_BACKING. */
    if (!g_nmounts) {
        const char *p = getenv("VFS_PREFIX");
        const char *b = getenv("VFS_BACKING");
        if (!p || !*p) p = "/vfs";
        if (!b || !*b) b = "/tmp/vfsstore";
        mount_add(p, strlen(p), b, strlen(b));
    }

    /* Best-effort create each backing root so the VFS exists on first use. */
    int (*real_mkdir)(const char *, mode_t) = dlsym(RTLD_NEXT, "mkdir");
    int saved = errno;
    for (int i = 0; real_mkdir && i < g_nmounts; i++) mkdir_p(real_mkdir, g_mounts[i].backing);
    errno = saved;
}

/* Is `path` exactly `dir`, or under it? */
static int under(const char *path, const char *dir, size_t dirlen) {
    if (strncmp(path, dir, dirlen) != 0) return 0;
    return path[dirlen] == '/' || path[dirlen] == '\0';   /* "/vfsx" is not under "/vfs" */
}

/* The mount a virtual path falls in: the longest matching prefix, so a mount
 * nested inside another wins for its own subtree. NULL when it is not ours. */
static const struct vfs_mount *mount_of(const char *path) {
    const struct vfs_mount *best = NULL;
    for (int i = 0; i < g_nmounts; i++) {
        const struct vfs_mount *m = &g_mounts[i];
        if (under(path, m->prefix, m->prefixlen) && (!best || m->prefixlen > best->prefixlen)) best = m;
    }
    return best;
}

/* The mount a real path falls in, by backing directory. */
static const struct vfs_mount *mount_of_backing(const char *path) {
    const struct vfs_mount *best = NULL;
    for (int i = 0; i < g_nmounts; i++) {
        const struct vfs_mount *m = &g_mounts[i];
        if (under(path, m->backing, m->backinglen) && (!best || m->backinglen > best->backinglen)) best = m;
    }
    return best;
}

/* ---- path translation ---------------------------------------------------- */

/*
 * If `path` is absolute and under a mount, rewrite it into that mount's backing
 * directory in `buf` and return `buf`. Otherwise return `path` unchanged.
 *
 * Only absolute virtual paths are translated. Relative paths are left alone: a
 * dirfd obtained via opendir/open on a virtual path (or a cwd set via chdir)
 * already points into the backing store, so relative resolution is correct on
 * its own.
 */
static const char *xlate(const char *path, char *buf, size_t bufsz) {
    if (!path) return path;
    if (!g_init) vfs_init();  /* hooked before our constructor ran */
    const struct vfs_mount *m = mount_of(path);
    if (!m) return path;
    /* path + prefixlen keeps the leading '/' (or "" for the root itself). */
    size_t restlen = strlen(path + m->prefixlen);
    if (m->backinglen + restlen + 1 > bufsz) return path;   /* too long; fall through */
    memcpy(buf, m->backing, m->backinglen);
    memcpy(buf + m->backinglen, path + m->prefixlen, restlen + 1);
    return buf;
}

/*
 * Reverse: if `buf` (NUL-terminated, capacity `bufsz`) is under a backing
 * directory, rewrite it in place to the virtual prefix. Returns 1 if rewritten,
 * 0 if not ours, -1 if it would not fit.
 */
static int unxlate(char *buf, size_t bufsz) {
    if (!g_init) vfs_init();
    const struct vfs_mount *m = mount_of_backing(buf);
    if (!m) return 0;
    size_t restlen = strlen(buf + m->backinglen);
    if (m->prefixlen + restlen + 1 > bufsz) return -1;
    memmove(buf + m->prefixlen, buf + m->backinglen, restlen + 1);
    memcpy(buf, m->prefix, m->prefixlen);
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

/* The supervisor's say on `op` for virtual path `p` (and `p2` for rename). */
static int notify(const char *op, const char *p, const char *p2, int flags) {
    return transport_call(op, p, p2, flags);
}

/* ---- open files ------------------------------------------------------------
 * One entry per descriptor opened for writing on a virtual file. The supervisor
 * is told "open" when it is opened and "flush" when the last reference is
 * closed or fsync'd, so it can persist the backing file. */

struct vfs_file {
    char *vpath;            /* virtual path, or NULL when the fd is not ours */
    unsigned char wlock;    /* 1 while the program holds a write lock (fcntl F_WRLCK /
                             * flock LOCK_EX) on it, i.e. the supervisor holds the lease */
};

#define FD_MAX 65536
static struct vfs_file g_files[FD_MAX];

static void fd_track(int fd, const char *vpath) {
    if (fd < 0 || fd >= FD_MAX) return;
    char *copy = strdup(vpath);
    pthread_mutex_lock(&g_lock);
    free(g_files[fd].vpath);
    g_files[fd].vpath = copy;
    pthread_mutex_unlock(&g_lock);
}

/* Removes and returns the tracked path (caller frees), or NULL. */
static char *fd_take(int fd) {
    if (fd < 0 || fd >= FD_MAX) return NULL;
    pthread_mutex_lock(&g_lock);
    char *p = g_files[fd].vpath;
    g_files[fd].vpath = NULL;
    pthread_mutex_unlock(&g_lock);
    return p;
}

/* Copies the tracking of `from` onto `to` (dup family). */
static void fd_copy(int from, int to) {
    if (from < 0 || from >= FD_MAX || to < 0 || to >= FD_MAX || from == to) return;
    pthread_mutex_lock(&g_lock);
    char *p = g_files[from].vpath ? strdup(g_files[from].vpath) : NULL;
    free(g_files[to].vpath);
    g_files[to].vpath = p;
    pthread_mutex_unlock(&g_lock);
}

/* Copy of the tracked path (caller frees), or NULL when `fd` is not ours. */
static char *fd_path(int fd) {
    if (fd < 0 || fd >= FD_MAX) return NULL;
    pthread_mutex_lock(&g_lock);
    char *p = g_files[fd].vpath ? strdup(g_files[fd].vpath) : NULL;
    pthread_mutex_unlock(&g_lock);
    return p;
}

static int fd_wlocked(int fd) {
    return fd >= 0 && fd < FD_MAX && g_files[fd].wlock;
}

/* Forward the program's advisory lock transitions to the supervisor:
 *   read lock   -> "revalidate" (make the local copy current), unless this fd
 *                  already holds the write lock (a downgrade, not a new read)
 *   write lock  -> "lock" (take the lease; EAGAIN when someone else holds it)
 *   unlock      -> "flush" then "unlock", only if a write lock was held
 * Plain POSIX semantics, no knowledge of any program. Returns 0 to proceed with
 * the real lock call, -1 with errno to fail it. */
static int lock_transition(int fd, int type) {
    char *vp = fd_path(fd);
    if (!vp) return 0;
    int r = 0;
    if (type == F_WRLCK) {
        if (!g_files[fd].wlock) {
            r = notify("lock", vp, NULL, 0);
            if (r == 0) g_files[fd].wlock = 1;
        }
    } else if (type == F_RDLCK) {
        if (!g_files[fd].wlock) r = notify("revalidate", vp, NULL, 0);
    } else if (type == F_UNLCK) {
        if (g_files[fd].wlock) {
            r = notify("flush", vp, NULL, 0);
            g_files[fd].wlock = 0;
            int u = notify("unlock", vp, NULL, 0);
            if (r == 0) r = u;
        }
    }
    free(vp);
    return r;
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
    char *vp = take ? fd_take(fd) : fd_path(fd);
    if (!vp) return 0;
    int r = notify("flush", vp, NULL, 0);
    free(vp);
    return r;
}

#endif /* VFS_CORE_H */
