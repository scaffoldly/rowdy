/*
 * vfs_transport.h — the client for the supervisor protocol.
 *
 * Knows nothing about mounts or descriptors: it carries an operation on one or
 * two virtual paths to the supervisor and returns its verdict. Requests and
 * replies are one JSON object per line over a unix-domain stream socket
 * (VFS_SOCKET); only paths, flags and metadata cross it. See DISCLOSURE.
 */
#ifndef VFS_TRANSPORT_H
#define VFS_TRANSPORT_H

static const char *g_socket;    /* supervisor socket path, or NULL */

/* libc's close, resolved past our own hook */
static int (*real_close_)(int);

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int   g_ipc = -1;    /* connected socket, owned by g_ipc_pid */
static pid_t g_ipc_pid;

static void transport_init(void) {
    const char *s = getenv("VFS_SOCKET");
    g_socket = (s && *s) ? s : NULL;
    real_close_ = (int (*)(int))dlsym(RTLD_NEXT, "close");
}

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

/* Ask the supervisor about `op` on virtual path `p` (and `p2` for rename).
 * `flags` are the open(2) flags for "open". No-op (0) without VFS_SOCKET. */
static int transport_call(const char *op, const char *p, const char *p2, int flags) {
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

#endif /* VFS_TRANSPORT_H */
