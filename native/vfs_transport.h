/*
 * vfs_transport.h — a 9P2000.L client for the supervisor socket.
 *
 * Knows nothing about mounts or descriptors: it carries 9P requests to the
 * supervisor and returns their replies. One connection per process (a fork
 * reconnects), one request in flight at a time under g_lock. Every message is
 * `size[4] type[1] tag[2]` plus fields, little-endian; an Rlerror carries a Linux
 * errno, which is what the caller gets back. See DISCLOSURE.
 */
#ifndef VFS_TRANSPORT_H
#define VFS_TRANSPORT_H

#include <stdint.h>

static const char *g_socket;    /* supervisor socket path, or NULL */

/* libc's close, resolved past our own hook */
static int (*real_close_)(int);

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int      g_ipc = -1;     /* connected socket, owned by g_ipc_pid */
static pid_t    g_ipc_pid;
static uint32_t g_msize;        /* negotiated by Tversion */
static uint16_t g_tag;
static uint32_t g_nextfid = 1;  /* 0 is never handed out; NOFID is 0xffffffff */

#define P9_VERSION  "9P2000.L"
#define P9_MSIZE    65536u
#define P9_NOTAG    0xffffu
#define P9_NOFID    0xffffffffu
#define P9_MAXWELEM 16

enum {
    Rlerror = 7, Tlopen = 12, Treaddir = 40, Tfsync = 50, Tlock = 52, Tmkdir = 72,
    Trenameat = 74, Tunlinkat = 76, Tversion = 100, Tattach = 104, Twalk = 110, Tclunk = 120,
};

enum { P9_LOCK_RDLCK = 0, P9_LOCK_WRLCK = 1, P9_LOCK_UNLCK = 2 };
enum { P9_LOCK_SUCCESS = 0, P9_LOCK_BLOCKED = 1, P9_LOCK_ERROR = 2, P9_LOCK_GRACE = 3 };
#define P9_AT_REMOVEDIR 0x200u

static void transport_init(void) {
    const char *s = getenv("VFS_SOCKET");
    g_socket = (s && *s) ? s : NULL;
    real_close_ = (int (*)(int))dlsym(RTLD_NEXT, "close");
}

/* ---- message building ---------------------------------------------------- */

struct p9buf { unsigned char *p; size_t len, cap; int err; };

static void put8(struct p9buf *b, uint8_t v) {
    if (b->len + 1 > b->cap) { b->err = 1; return; }
    b->p[b->len++] = v;
}
static void put16(struct p9buf *b, uint16_t v) { put8(b, v & 0xff); put8(b, v >> 8); }
static void put32(struct p9buf *b, uint32_t v) { put16(b, v & 0xffff); put16(b, v >> 16); }
static void put64(struct p9buf *b, uint64_t v) { put32(b, (uint32_t)v); put32(b, (uint32_t)(v >> 32)); }
static void puts9(struct p9buf *b, const char *s, size_t n) {
    if (n > 0xffff) { b->err = 1; return; }
    put16(b, (uint16_t)n);
    if (b->len + n > b->cap) { b->err = 1; return; }
    memcpy(b->p + b->len, s, n);
    b->len += n;
}

static void begin(struct p9buf *b, unsigned char *mem, size_t cap, uint8_t type, uint16_t tag) {
    b->p = mem; b->len = 0; b->cap = cap; b->err = 0;
    put32(b, 0); put8(b, type); put16(b, tag);
}

static uint16_t get16(const unsigned char *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t get32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static uint16_t nexttag(void) {
    if (++g_tag == P9_NOTAG) g_tag = 1;
    return g_tag;
}

/* ---- connection ---------------------------------------------------------- */

/* The core's hook: re-attach its mounts after a (re)connect. Called with g_lock held. */
static int (*g_on_connect)(void);

static int sendall(int fd, const unsigned char *p, size_t n) {
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        p += w; n -= (size_t)w;
    }
    return 0;
}

static int recvall(int fd, unsigned char *p, size_t n) {
    while (n) {
        ssize_t r = read(fd, p, n);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return -1;
        p += r; n -= (size_t)r;
    }
    return 0;
}

/* Must be called with g_lock held. One round trip; the reply lands in `reply`.
 * 0 on an R-message, -1 with errno on a transport failure or an Rlerror. */
static int exchange_locked(struct p9buf *req, unsigned char *reply, size_t cap) {
    if (req->err) { errno = ENAMETOOLONG; return -1; }
    req->p[0] = req->len & 0xff; req->p[1] = (req->len >> 8) & 0xff;
    req->p[2] = (req->len >> 16) & 0xff; req->p[3] = (req->len >> 24) & 0xff;
    if (sendall(g_ipc, req->p, req->len) < 0) goto lost;
    if (recvall(g_ipc, reply, 7) < 0) goto lost;
    uint32_t size = get32(reply);
    if (size < 7 || size > cap) goto lost;
    if (recvall(g_ipc, reply + 7, size - 7) < 0) goto lost;
    if (reply[4] == Rlerror) {
        errno = size >= 11 ? (int)get32(reply + 7) : EIO;
        if (errno <= 0) errno = EIO;
        return -1;
    }
    return 0;
lost:
    real_close_(g_ipc); g_ipc = -1;
    errno = EIO;
    return -1;
}

/* Must be called with g_lock held. Connects, negotiates the version and lets the
 * core re-attach its mounts. An unreachable supervisor is an error, not a silent
 * skip: the operator asked for the socket, so losing it must be loud. */
static int connect_locked(void) {
    pid_t pid = getpid();
    if (g_ipc >= 0 && g_ipc_pid == pid) return 0;
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
    g_ipc = fd; g_ipc_pid = pid; g_nextfid = 1;

    unsigned char mem[64], reply[64]; struct p9buf b;
    begin(&b, mem, sizeof mem, Tversion, P9_NOTAG);
    put32(&b, P9_MSIZE); puts9(&b, P9_VERSION, strlen(P9_VERSION));
    if (exchange_locked(&b, reply, sizeof reply) < 0) return -1;
    g_msize = get32(reply + 7);
    if (g_msize < 128 || g_msize > P9_MSIZE) g_msize = P9_MSIZE;
    /* reply[11..] is the version string; "unknown" means ours is not spoken */
    size_t vlen = strlen(P9_VERSION);
    if (get16(reply + 11) != vlen || memcmp(reply + 13, P9_VERSION, vlen) != 0) {
        real_close_(g_ipc); g_ipc = -1;
        errno = EPROTONOSUPPORT;
        return -1;
    }
    return g_on_connect ? g_on_connect() : 0;
}

/* A request built by `fill`, answered into `reply`. Locks, (re)connects, and keeps
 * errno untouched on success. */
static int p9_call(uint8_t type, void (*fill)(struct p9buf *, void *), void *arg, unsigned char *reply, size_t cap) {
    if (!g_socket) { errno = ENOTCONN; return -1; }
    unsigned char mem[2 * PATH_MAX + 256];
    int saved = errno;
    pthread_mutex_lock(&g_lock);
    if (connect_locked() < 0) { int e = errno; pthread_mutex_unlock(&g_lock); errno = e; return -1; }
    struct p9buf b;
    begin(&b, mem, sizeof mem, type, nexttag());
    fill(&b, arg);
    int r = exchange_locked(&b, reply, cap);
    int e = errno;
    pthread_mutex_unlock(&g_lock);
    errno = r == 0 ? saved : e;
    return r;
}

/* Connect (and let the core attach) before anything reads a root fid. */
static int ensure_connected(void) {
    if (!g_socket) { errno = ENOTCONN; return -1; }
    pthread_mutex_lock(&g_lock);
    int r = connect_locked();
    int e = errno;
    pthread_mutex_unlock(&g_lock);
    if (r < 0) errno = e;
    return r;
}

static uint32_t newfid(void) {
    pthread_mutex_lock(&g_lock);
    uint32_t f = g_nextfid++;
    if (g_nextfid == P9_NOFID) g_nextfid = 1;
    pthread_mutex_unlock(&g_lock);
    return f;
}

/* ---- the requests the core uses -------------------------------------------- */

/* Must be called with g_lock held: this is what the connect hook sends. */
static int p9_attach_locked(uint32_t fid, const char *aname) {
    unsigned char mem[PATH_MAX + 64], reply[64]; struct p9buf b;
    begin(&b, mem, sizeof mem, Tattach, nexttag());
    put32(&b, fid); put32(&b, P9_NOFID);
    puts9(&b, "rowdy", 5); puts9(&b, aname, strlen(aname)); put32(&b, 0);
    return exchange_locked(&b, reply, sizeof reply);
}

struct walk_args { uint32_t fid, newfid; const char *names[P9_MAXWELEM]; size_t lens[P9_MAXWELEM]; int n; };
static void fill_walk(struct p9buf *b, void *v) {
    struct walk_args *a = v;
    put32(b, a->fid); put32(b, a->newfid); put16(b, (uint16_t)a->n);
    for (int i = 0; i < a->n; i++) puts9(b, a->names[i], a->lens[i]);
}

/* Walk `rel` ("" or "a/b/c") from `root` into a fresh fid in `*out`. Sixteen
 * names per message, as the protocol allows; a partial walk is ENOENT. */
static int p9_walk(uint32_t root, const char *rel, uint32_t *out) {
    unsigned char reply[7 + 2 + 13 * P9_MAXWELEM];
    uint32_t from = root, to = newfid();
    const char *p = rel;
    for (int first = 1;; first = 0) {
        struct walk_args a = { from, to, {0}, {0}, 0 };
        while (*p && a.n < P9_MAXWELEM) {
            while (*p == '/') p++;
            if (!*p) break;
            const char *e = strchr(p, '/');
            a.names[a.n] = p;
            a.lens[a.n] = e ? (size_t)(e - p) : strlen(p);
            a.n++;
            p = e ? e : p + strlen(p);
        }
        if (!first && a.n == 0) break;
        if (p9_call(Twalk, fill_walk, &a, reply, sizeof reply) < 0) return -1;
        if (get16(reply + 7) != a.n) { errno = ENOENT; return -1; }
        from = to;   /* the next sixteen continue from the new fid */
        if (!*p) break;
    }
    *out = to;
    return 0;
}

struct fid_args { uint32_t fid; };
static void fill_fid(struct p9buf *b, void *v) { put32(b, ((struct fid_args *)v)->fid); }

static int p9_clunk(uint32_t fid) {
    unsigned char reply[16]; struct fid_args a = { fid };
    return p9_call(Tclunk, fill_fid, &a, reply, sizeof reply);
}
static int p9_fsync(uint32_t fid) {
    unsigned char reply[16]; struct fid_args a = { fid };
    return p9_call(Tfsync, fill_fid, &a, reply, sizeof reply);
}

/* Treaddir from offset 0 for one entry's worth: the server lists the directory into the
 * backing store on the first readdir, and the entries themselves are read there. */
#define READDIR_REPLY (11 + 24 + NAME_MAX + 1)
static void fill_readdir(struct p9buf *b, void *v) {
    fill_fid(b, v); put64(b, 0); put32(b, READDIR_REPLY - 11);
}
static int p9_readdir(uint32_t fid) {
    unsigned char reply[READDIR_REPLY]; struct fid_args a = { fid };
    return p9_call(Treaddir, fill_readdir, &a, reply, sizeof reply);
}

struct lopen_args { uint32_t fid, flags; };
static void fill_lopen(struct p9buf *b, void *v) {
    struct lopen_args *a = v;
    put32(b, a->fid); put32(b, a->flags);
}
static int p9_lopen(uint32_t fid, uint32_t flags) {
    unsigned char reply[32]; struct lopen_args a = { fid, flags };
    return p9_call(Tlopen, fill_lopen, &a, reply, sizeof reply);
}

struct lock_args { uint32_t fid; uint8_t type; };
static void fill_lock(struct p9buf *b, void *v) {
    struct lock_args *a = v;
    put32(b, a->fid); put8(b, a->type); put32(b, 0); put64(b, 0); put64(b, 0);
    put32(b, (uint32_t)getpid()); puts9(b, "shim", 4);
}
/* 0 on SUCCESS; -1 with EAGAIN on BLOCKED, or with the Rlerror errno. */
static int p9_lock(uint32_t fid, uint8_t type) {
    unsigned char reply[16]; struct lock_args a = { fid, type };
    if (p9_call(Tlock, fill_lock, &a, reply, sizeof reply) < 0) return -1;
    if (reply[7] == P9_LOCK_SUCCESS) return 0;
    errno = reply[7] == P9_LOCK_BLOCKED ? EAGAIN : EIO;
    return -1;
}

struct name_args { uint32_t fid; const char *name; uint32_t flags, mode; };
static void fill_mkdir(struct p9buf *b, void *v) {
    struct name_args *a = v;
    put32(b, a->fid); puts9(b, a->name, strlen(a->name)); put32(b, a->mode); put32(b, 0);
}
static int p9_mkdir(uint32_t dfid, const char *name, uint32_t mode) {
    unsigned char reply[32]; struct name_args a = { dfid, name, 0, mode };
    return p9_call(Tmkdir, fill_mkdir, &a, reply, sizeof reply);
}
static void fill_unlinkat(struct p9buf *b, void *v) {
    struct name_args *a = v;
    put32(b, a->fid); puts9(b, a->name, strlen(a->name)); put32(b, a->flags);
}
static int p9_unlinkat(uint32_t dfid, const char *name, uint32_t flags) {
    unsigned char reply[16]; struct name_args a = { dfid, name, flags, 0 };
    return p9_call(Tunlinkat, fill_unlinkat, &a, reply, sizeof reply);
}

struct renameat_args { uint32_t ofid; const char *oname; uint32_t nfid; const char *nname; };
static void fill_renameat(struct p9buf *b, void *v) {
    struct renameat_args *a = v;
    put32(b, a->ofid); puts9(b, a->oname, strlen(a->oname));
    put32(b, a->nfid); puts9(b, a->nname, strlen(a->nname));
}
static int p9_renameat(uint32_t ofid, const char *oname, uint32_t nfid, const char *nname) {
    unsigned char reply[16]; struct renameat_args a = { ofid, oname, nfid, nname };
    return p9_call(Trenameat, fill_renameat, &a, reply, sizeof reply);
}

#endif /* VFS_TRANSPORT_H */
