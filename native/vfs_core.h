/*
 * vfs_core.h — the filesystem's own state: what is mounted where, how a path
 * maps into a mount, and which descriptors are open on virtual files.
 *
 * Depends on vfs_transport.h and on nothing above it. The interposition layer
 * uses only what is declared here: xlate/unxlate, notify, pre_open/post_open,
 * flush_fd, lock_transition and the fd table helpers.
 *
 * The supervisor is a 9P2000.L server. A path operation is a walk from the
 * mount's root fid, the operation on the fid, and a clunk; a descriptor opened
 * for writing keeps its fid for as long as it is open, so fsync, locks and the
 * final close address the same handle the supervisor already knows.
 */
#ifndef VFS_CORE_H
#define VFS_CORE_H

/* Bind dlsym's original symbol version. glibc 2.34 moved dlsym from libdl into libc under a new
 * version; requiring it makes older glibc fail every preloaded process before main. The original
 * version is still exported by libc.so.6 on 2.34+, and by libdl.so.2 (a dependency, see build.sh)
 * below it. musl ignores symbol versions. */
#if defined(__x86_64__)
__asm__(".symver dlsym,dlsym@GLIBC_2.2.5");
#elif defined(__aarch64__)
__asm__(".symver dlsym,dlsym@GLIBC_2.17");
#endif

/* ---- mount table (read once) ---------------------------------------------- */

/* A virtual prefix (e.g. "/vfs") served from a real directory (e.g.
 * "/tmp/vfsstore"). Neither ends in '/'. */
struct vfs_mount {
    char    *prefix;
    size_t   prefixlen;
    char    *backing;
    size_t   backinglen;
    uint32_t rootfid;   /* attached on connect; valid while g_ipc is */
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

/* Attach every mount on a fresh connection. Called by the transport with g_lock held. */
static int attach_all_locked(void) {
    for (int i = 0; i < g_nmounts; i++) {
        g_mounts[i].rootfid = g_nextfid++;
        if (p9_attach_locked(g_mounts[i].rootfid, g_mounts[i].prefix) < 0) return -1;
    }
    return 0;
}

static void vfs_init(void) __attribute__((constructor));
static void vfs_init(void) {
    if (g_init) return;
    g_init = 1;

    transport_init();
    g_on_connect = attach_all_locked;

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

/* The path relative to its mount: "" for the root, else without a leading '/'. */
static const char *rel_of(const struct vfs_mount *m, const char *path) {
    const char *r = path + m->prefixlen;
    while (*r == '/') r++;
    return r;
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

/* REAL for a function with no public prototype (glibc's fortify entry points). */
#define REAL_T(name, type) \
    static type real_; \
    if (!real_) real_ = (type)dlsym(RTLD_NEXT, #name)

/* ---- the supervisor's say ----------------------------------------------------
 * Each path operation is walk, operation, clunk. The walk already runs the
 * store's stat hook for the path; lopen runs fetch (read), open (write) or
 * list (directory); clunk persists anything written through the fid. */

/* Walk `rel` within `m`; -1 with errno when it is not there. */
static int walk_to(const struct vfs_mount *m, const char *rel, uint32_t *fid) {
    return p9_walk(m->rootfid, rel, fid);
}

/* Walk to the parent of `rel` and point `*name` at the last component. */
static int walk_parent(const struct vfs_mount *m, const char *rel, uint32_t *fid, const char **name) {
    static __thread char parent[PATH_MAX];
    const char *slash = strrchr(rel, '/');
    if (!slash) { parent[0] = '\0'; *name = rel; }
    else {
        size_t n = (size_t)(slash - rel);
        if (n >= sizeof parent) { errno = ENAMETOOLONG; return -1; }
        memcpy(parent, rel, n); parent[n] = '\0';
        *name = slash + 1;
    }
    if (!**name) { errno = EINVAL; return -1; }   /* the mount root has no parent here */
    return walk_to(m, parent, fid);
}

/* Walk, lopen with `flags`, clunk: the store populates (or registers) `rel`.
 * A directory is listed by readdir, not by open: fsync(dirfd) must not cost a listing. */
static int touch(const struct vfs_mount *m, const char *rel, uint32_t flags) {
    uint32_t fid;
    if (walk_to(m, rel, &fid) < 0) return -1;
    int r = p9_lopen(fid, flags);
    if (r == 0 && (flags & O_DIRECTORY)) r = p9_readdir(fid);
    int e = errno;
    p9_clunk(fid);
    errno = e;
    return r;
}

/* Tell the supervisor about `op` on virtual path `p` (and `p2` for rename).
 * `flags` are the open(2) flags for "open". 0 without VFS_SOCKET, or when the
 * path is not under a mount. */
static int notify(const char *op, const char *p, const char *p2, int flags) {
    (void)flags;
    if (!g_socket) return 0;
    const struct vfs_mount *m = mount_of(p);
    if (!m) return 0;
    if (ensure_connected() < 0) return -1;   /* root fids exist only once attached */
    const char *rel = rel_of(m, p);
    uint32_t fid;
    const char *name;
    int r, e;

    if (strcmp(op, "stat") == 0) {
        if (walk_to(m, rel, &fid) < 0) return -1;
        p9_clunk(fid);
        return 0;
    }
    if (strcmp(op, "fetch") == 0) return touch(m, rel, O_RDONLY);
    if (strcmp(op, "list") == 0) return touch(m, rel, O_RDONLY | O_DIRECTORY);
    if (strcmp(op, "flush") == 0) return touch(m, rel, O_WRONLY);   /* written outside a descriptor we track */
    if (strcmp(op, "mkdir") == 0) {
        if (walk_parent(m, rel, &fid, &name) < 0) return -1;
        r = p9_mkdir(fid, name, 0777); e = errno;
        p9_clunk(fid); errno = e;
        return r;
    }
    if (strcmp(op, "unlink") == 0) {
        if (walk_parent(m, rel, &fid, &name) < 0) return -1;
        r = p9_unlinkat(fid, name, 0); e = errno;
        p9_clunk(fid); errno = e;
        return r;
    }
    if (strcmp(op, "rename") == 0) {
        const struct vfs_mount *m2 = p2 ? mount_of(p2) : NULL;
        if (!m2 || m2 != m) {
            /* Across mounts (or out of them): the bytes already moved on disk, so to the
             * stores this is a file gone from one place and a new one in another. */
            if (notify("unlink", p, NULL, 0) < 0) return -1;
            return m2 ? notify("flush", p2, NULL, 0) : 0;
        }
        const char *rel2 = rel_of(m2, p2), *name2;
        uint32_t fid2;
        if (walk_parent(m, rel, &fid, &name) < 0) return -1;
        if (walk_parent(m2, rel2, &fid2, &name2) < 0) { e = errno; p9_clunk(fid); errno = e; return -1; }
        r = p9_renameat(fid, name, fid2, name2); e = errno;
        p9_clunk(fid); p9_clunk(fid2); errno = e;
        return r;
    }
    errno = EINVAL;
    return -1;
}

/* ---- open files ------------------------------------------------------------
 * One entry per descriptor opened for writing on a virtual file: the fid the
 * supervisor knows it by. dup'd descriptors share the fid through a count, so
 * it is clunked (and the file persisted) when the last of them closes. */

struct vfs_file {
    uint32_t fid;
    int     *refs;          /* shared by every descriptor dup'd from this one; NULL when not ours */
    unsigned char wlock;    /* 1 while the program holds a write lock (fcntl F_WRLCK / flock LOCK_EX),
                             * i.e. while the supervisor holds the lease */
    unsigned char rlock;    /* 1 while the program holds a read lock: the copy was made current once */
};

#define FD_MAX 65536
static struct vfs_file g_files[FD_MAX];

static void fd_track(int fd, uint32_t fid) {
    if (fd < 0 || fd >= FD_MAX) return;
    int *refs = malloc(sizeof *refs);
    if (refs) *refs = 1;
    pthread_mutex_lock(&g_lock);
    g_files[fd].fid = fid;
    g_files[fd].refs = refs;
    g_files[fd].wlock = 0;
    g_files[fd].rlock = 0;
    pthread_mutex_unlock(&g_lock);
}

/* Copies the tracking of `from` onto `to` (dup family): one more reference to the fid. */
static void fd_copy(int from, int to) {
    if (from < 0 || from >= FD_MAX || to < 0 || to >= FD_MAX || from == to) return;
    pthread_mutex_lock(&g_lock);
    if (g_files[from].refs) {
        (*g_files[from].refs)++;
        g_files[to] = g_files[from];
        g_files[to].wlock = 0;
        g_files[to].rlock = 0;
    } else {
        g_files[to].refs = NULL;
    }
    pthread_mutex_unlock(&g_lock);
}

static int fd_tracked(int fd) {
    return fd >= 0 && fd < FD_MAX && g_files[fd].refs != NULL;
}

static int fd_wlocked(int fd) {
    return fd_tracked(fd) && g_files[fd].wlock;
}

/* The fid opened by pre_open, waiting for post_open to bind it to the descriptor.
 * One open(2) is in flight per thread at a time. */
static __thread uint32_t g_pending = P9_NOFID;

/* Before opening virtual path `vp`: walk to it and open it on the supervisor, so
 * the backing file is populated (a read) or the store knows a write is coming.
 * The fid stays open with the descriptor for as long as it is, readers included,
 * so the supervisor knows which files are in use. A missing object is only an
 * error when the caller is not creating; the file is then opened after the real
 * open has made it. */
static int pre_open(const char *vp, int flags) {
    g_pending = P9_NOFID;
    if (!g_socket) return 0;
    const struct vfs_mount *m = mount_of(vp);
    if (!m) return 0;
    if (ensure_connected() < 0) return -1;
    uint32_t fid;
    if (walk_to(m, rel_of(m, vp), &fid) < 0) return (flags & O_CREAT) && errno == ENOENT ? 0 : -1;
    if (p9_lopen(fid, (uint32_t)flags & ~(uint32_t)O_CREAT) < 0) {
        int e = errno; p9_clunk(fid); errno = e; return -1;
    }
    g_pending = fid;
    return 0;
}

/* After the real open of `vp` as `fd`: bind the pending fid to the descriptor, or,
 * for a file the real open just created, open it on the supervisor now. */
static int post_open(int fd, const char *vp, int flags) {
    uint32_t fid = g_pending;
    g_pending = P9_NOFID;
    if (fd < 0) {
        if (fid != P9_NOFID) { int e = errno; p9_clunk(fid); errno = e; }
        return fd;
    }
    if (!g_socket) return fd;
    const struct vfs_mount *m = mount_of(vp);
    if (!m) return fd;
    if (fid == P9_NOFID) {
        if (ensure_connected() < 0 || walk_to(m, rel_of(m, vp), &fid) < 0 ||
            p9_lopen(fid, (uint32_t)flags & ~(uint32_t)O_CREAT) < 0) {
            int e = errno; real_close_(fd); errno = e; return -1;
        }
    }
    fd_track(fd, fid);
    return fd;
}

/* On fsync: persist through the fid. On the last close: clunk it, which persists
 * and gives back any lease. */
static int flush_fd(int fd, int take) {
    if (!fd_tracked(fd)) return 0;
    pthread_mutex_lock(&g_lock);
    uint32_t fid = g_files[fd].fid;
    int last = 0;
    if (take) {
        last = --(*g_files[fd].refs) == 0;
        if (last) free(g_files[fd].refs);
        g_files[fd].refs = NULL;
        g_files[fd].wlock = 0;
        g_files[fd].rlock = 0;
    }
    pthread_mutex_unlock(&g_lock);
    if (!take) return p9_fsync(fid);
    return last ? p9_clunk(fid) : 0;
}

/* Forward the program's advisory lock transitions to the supervisor:
 *   read lock   -> Tlock RDLCK (the store makes the local copy current), once per
 *                  held read lock (SQLite locks two byte ranges for one SHARED), and
 *                  not while this fd holds the write lock (a downgrade, not a new read)
 *   write lock  -> Tlock WRLCK (the store takes the lease; BLOCKED is EAGAIN)
 *   unlock      -> Tlock UNLCK (persist, give the lease back), only after a write lock
 * Plain POSIX semantics, no knowledge of any program. Returns 0 to proceed with
 * the real lock call, -1 with errno to fail it. */
static int lock_transition(int fd, int type) {
    if (!fd_tracked(fd)) return 0;
    uint32_t fid = g_files[fd].fid;
    int r = 0;
    if (type == F_WRLCK) {
        if (!g_files[fd].wlock) {
            r = p9_lock(fid, P9_LOCK_WRLCK);
            if (r == 0) g_files[fd].wlock = 1;
        }
    } else if (type == F_RDLCK) {
        if (!g_files[fd].wlock && !g_files[fd].rlock) {
            r = p9_lock(fid, P9_LOCK_RDLCK);
            if (r == 0) g_files[fd].rlock = 1;
        }
    } else if (type == F_UNLCK) {
        g_files[fd].rlock = 0;
        if (g_files[fd].wlock) {
            g_files[fd].wlock = 0;
            r = p9_lock(fid, P9_LOCK_UNLCK);
        }
    }
    return r;
}

#endif /* VFS_CORE_H */
