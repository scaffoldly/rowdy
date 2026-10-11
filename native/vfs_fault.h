/*
 * vfs_fault.h — what a fatal SIGSEGV/SIGBUS in a preloaded process was doing.
 *
 * Depends on nothing else here, so every layer can leave a breadcrumb: the hook a
 * thread is in (and its path) and the 9P request it is waiting on. When the process
 * faults, the handler writes one report to stderr, then lets the program's own
 * handler run (Node's checks for a WebAssembly trap and otherwise dies by the
 * signal) or dies by the signal itself, so the exit status is unchanged:
 *
 *   rowdy-vfs: fatal SIGSEGV (signal 11, code 1 SEGV_MAPERR) at 0x0, tid 42
 *   rowdy-vfs: pc 0x7f…  r-xp /usr/local/bin/node+0x1a2b3c
 *   rowdy-vfs: sp 0x7f…  rw-p [stack]; fault address is 120 bytes below the stack pointer
 *   rowdy-vfs: inside scandir("/vfs/x") (depth 1), waiting on 9P Treaddir
 *   rowdy-vfs: frame 1 0x7f…  r-xp /lib/ld-musl-x86_64.so.1+0x5c1e0
 *
 * The handler only makes raw system calls through libc's syscall(), resolved before
 * any fault: no allocation, no stdio, nothing that reaches our own hooks.
 *
 * A program that installs its own handler for these signals has it recorded and
 * called from ours, so ours stays first and runs on an alternate stack, which
 * every thread gets (pthread_create is interposed): a stack overflow is reported
 * like any other fault. V8 claims WebAssembly bounds traps before any of this.
 * A program with a handler of its own other than node's is not reported, since
 * that handler may recover from the fault.
 *
 * Opt-in: only VFS_FAULT_REPORT=1 turns it on (rowdy sets it at log level debug or
 * trace). Otherwise no handler is installed, no thread gets an alternate stack, the
 * sigaction, signal and pthread_create wrappers pass straight to libc, and no
 * breadcrumb is written.
 */
#ifndef VFS_FAULT_H
#define VFS_FAULT_H

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <pthread.h>
#include <ucontext.h>

static int g_fault_on;   /* VFS_FAULT_REPORT=1, set once by the constructor */

/* ---- breadcrumb ------------------------------------------------------------ */

#define CRUMB_PATH 160

/* The hook the thread last entered, how many hooks deep it is, the path that hook was given (when
 * `pathseq` matches `seq`) and the 9P request it is waiting on, if any. */
struct crumb {
    const char *fn;
    unsigned depth;
    unsigned seq, pathseq;
    const char *p9;
    char path[CRUMB_PATH];
};
static __thread struct crumb g_crumb;

static inline int crumb_enter(const char *fn) {
    if (!g_fault_on) return 0;
    g_crumb.fn = fn;
    g_crumb.depth++;
    g_crumb.seq++;
    return 0;
}
static inline void crumb_leave(int *unused) {
    (void)unused;
    if (g_crumb.depth) g_crumb.depth--;
}
static inline void crumb_path(const char *path) {
    if (!g_fault_on || !path) return;
    size_t n = 0;
    while (n < CRUMB_PATH - 1 && path[n]) n++;
    memcpy(g_crumb.path, path, n);
    g_crumb.path[n] = '\0';
    g_crumb.pathseq = g_crumb.seq;
}
static inline void crumb_p9_leave(const char **unused) {
    (void)unused;
    g_crumb.p9 = NULL;
}

/* In scope for the rest of the hook: entering it now, leaving it when the hook returns. */
#define CRUMB(name) int crumb_ __attribute__((cleanup(crumb_leave), unused)) = crumb_enter(name)
/* In scope for the rest of the request: the 9P message the thread is waiting on. */
#define CRUMB_P9(name) \
    const char *crumb_p9_ __attribute__((cleanup(crumb_p9_leave), unused)) = (g_crumb.p9 = g_fault_on ? (name) : NULL)

/* ---- report ------------------------------------------------------------------ */

static long (*g_syscall)(long, ...);      /* libc's own, past our hook */
static volatile sig_atomic_t g_faulting;  /* a fault is being reported: sigaction passes through */
static struct sigaction g_app[2];          /* the program's SIGSEGV and SIGBUS actions */
static int (*g_real_sigaction)(int, const struct sigaction *, struct sigaction *);
static _Bool (*g_wasm_trap)(int, siginfo_t *, void *);  /* v8::TryHandleWebAssemblyTrapPosix, a C++ bool */

#define FAULT_LINE 640

struct fault_out { char b[FAULT_LINE]; size_t n; };

static void fo_s(struct fault_out *o, const char *s) {
    while (s && *s && o->n < sizeof o->b - 1) o->b[o->n++] = *s++;
}
static void fo_u(struct fault_out *o, unsigned long v) {
    char d[24]; int i = 0;
    do { d[i++] = (char)('0' + v % 10); v /= 10; } while (v);
    while (i && o->n < sizeof o->b - 1) o->b[o->n++] = d[--i];
}
static void fo_x(struct fault_out *o, uintptr_t v) {
    char d[24]; int i = 0;
    do { d[i++] = "0123456789abcdef"[v & 15]; v >>= 4; } while (v);
    fo_s(o, "0x");
    while (i && o->n < sizeof o->b - 1) o->b[o->n++] = d[--i];
}
static void fo_line(struct fault_out *o) {
    o->b[o->n++] = '\n';
    for (size_t off = 0; off < o->n;) {
        long w = g_syscall(SYS_write, 2, o->b + off, o->n - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    o->n = 0;
    fo_s(o, "rowdy-vfs: ");
}

static const char *sig_name(int sig) { return sig == SIGBUS ? "SIGBUS" : sig == SIGSEGV ? "SIGSEGV" : "signal"; }
static const char *code_name(int sig, int code) {
    if (code == SI_USER) return "SI_USER";
    if (code == SI_TKILL) return "SI_TKILL";
    if (code == SI_QUEUE) return "SI_QUEUE";
    if (sig == SIGSEGV) return code == SEGV_MAPERR ? "SEGV_MAPERR" : code == SEGV_ACCERR ? "SEGV_ACCERR" : "";
    if (sig == SIGBUS) return code == BUS_ADRALN ? "BUS_ADRALN" : code == BUS_ADRERR ? "BUS_ADRERR"
                            : code == BUS_OBJERR ? "BUS_OBJERR" : "";
    return "";
}

/* One line of /proc/self/maps, for the address that falls in it. */
struct mapping {
    uintptr_t addr, start, end, offset;
    char perms[5];
    char path[CRUMB_PATH];
    int found;
};

static uintptr_t parse_hex(const char **p) {
    uintptr_t v = 0;
    for (;; (*p)++) {
        char c = **p;
        int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
        if (d < 0) return v;
        v = v << 4 | (uintptr_t)d;
    }
}

/* "start-end perms offset dev inode   path" */
static void match_line(const char *line, struct mapping *m, int n) {
    const char *p = line;
    uintptr_t start = parse_hex(&p);
    if (*p++ != '-') return;
    uintptr_t end = parse_hex(&p);
    if (*p++ != ' ') return;
    const char *perms = p;
    for (int i = 0; i < 4; i++) if (!*p++) return;
    if (*p++ != ' ') return;
    uintptr_t offset = parse_hex(&p);
    for (int field = 0; field < 2 && *p; field++) {   /* dev, inode */
        while (*p == ' ') p++;
        while (*p && *p != ' ') p++;
    }
    while (*p == ' ') p++;
    for (int i = 0; i < n; i++) {
        if (m[i].found || m[i].addr < start || m[i].addr >= end) continue;
        m[i].found = 1;
        m[i].start = start;
        m[i].end = end;
        m[i].offset = offset;
        memcpy(m[i].perms, perms, 4);
        m[i].perms[4] = '\0';
        size_t k = 0;
        while (p[k] && k < sizeof m[i].path - 1) { m[i].path[k] = p[k]; k++; }
        m[i].path[k] = '\0';
    }
}

/* Fill in each mapping's line from /proc/self/maps, in one pass. */
static void lookup_maps(struct mapping *m, int n) {
    long fd = g_syscall(SYS_openat, AT_FDCWD, "/proc/self/maps", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    char buf[2048], line[512];
    size_t len = 0;
    for (;;) {
        long r = g_syscall(SYS_read, fd, buf, sizeof buf);
        if (r <= 0) break;
        for (long i = 0; i < r; i++) {
            if (buf[i] != '\n') { if (len < sizeof line - 1) line[len++] = buf[i]; continue; }
            line[len] = '\0';
            match_line(line, m, n);
            len = 0;
        }
    }
    g_syscall(SYS_close, fd);
}

static void fo_mapping(struct fault_out *o, const struct mapping *m) {
    fo_x(o, m->addr);
    if (!m->found) { fo_s(o, "  (not mapped)"); return; }
    fo_s(o, "  ");
    fo_s(o, m->perms);
    fo_s(o, " ");
    if (m->path[0]) {
        fo_s(o, m->path);
        if (m->path[0] == '/') { fo_s(o, "+"); fo_x(o, m->addr - m->start + m->offset); }
    } else {
        fo_s(o, "[anonymous] ");
        fo_x(o, m->start);
        fo_s(o, "-");
        fo_x(o, m->end);
    }
}

#define FAULT_FRAMES 8

static void fault_report(int sig, siginfo_t *si, ucontext_t *uc) {
    uintptr_t pc = 0, sp = 0, fp = 0;
#if defined(__x86_64__)
    pc = (uintptr_t)uc->uc_mcontext.gregs[REG_RIP];
    sp = (uintptr_t)uc->uc_mcontext.gregs[REG_RSP];
    fp = (uintptr_t)uc->uc_mcontext.gregs[REG_RBP];
#elif defined(__aarch64__)
    pc = (uintptr_t)uc->uc_mcontext.pc;
    sp = (uintptr_t)uc->uc_mcontext.sp;
    fp = (uintptr_t)uc->uc_mcontext.regs[29];
#endif
    uintptr_t addr = (uintptr_t)si->si_addr;

    struct mapping m[3 + FAULT_FRAMES];
    memset(m, 0, sizeof m);
    m[0].addr = pc;
    m[1].addr = sp;
    m[2].addr = addr;
    lookup_maps(m, 3);

    /* Return addresses by frame pointer, read only from inside the stack the thread is on: a frame
     * pointer that leaves it (code built without one) ends the walk instead of faulting again. */
    int frames = 0;
    if (m[1].found) {
        for (uintptr_t f = fp; frames < FAULT_FRAMES; frames++) {
            if (f < sp || f % sizeof(uintptr_t) || f + 2 * sizeof(uintptr_t) > m[1].end) break;
            uintptr_t next = ((uintptr_t *)f)[0], ret = ((uintptr_t *)f)[1];
            if (!ret) break;
            m[3 + frames].addr = ret;
            if (next <= f) { frames++; break; }
            f = next;
        }
        lookup_maps(m + 3, frames);
    }

    struct fault_out o = { .n = 0 };
    fo_s(&o, "rowdy-vfs: fatal ");
    fo_s(&o, sig_name(sig));
    fo_s(&o, " (signal ");
    fo_u(&o, (unsigned long)sig);
    fo_s(&o, ", code ");
    if (si->si_code < 0) { fo_s(&o, "-"); fo_u(&o, (unsigned long)-si->si_code); }
    else fo_u(&o, (unsigned long)si->si_code);
    const char *code = code_name(sig, si->si_code);
    if (*code) { fo_s(&o, " "); fo_s(&o, code); }
    fo_s(&o, ")");
    if (si->si_code > 0) { fo_s(&o, " at "); fo_x(&o, addr); }
    fo_s(&o, ", tid ");
    fo_u(&o, (unsigned long)g_syscall(SYS_gettid));
    fo_line(&o);

    fo_s(&o, "pc ");
    fo_mapping(&o, &m[0]);
    fo_line(&o);

    fo_s(&o, "sp ");
    fo_mapping(&o, &m[1]);
    if (m[1].found && m[1].perms[0] == '-' && m[1].perms[1] == '-') fo_s(&o, "; in a guard page: stack overflow");
    if (si->si_code > 0) {
        uintptr_t d = addr < sp ? sp - addr : addr - sp;
        if (d <= 1 << 20) {
            fo_s(&o, "; fault address is ");
            fo_u(&o, (unsigned long)d);
            fo_s(&o, addr < sp ? " bytes below the stack pointer" : " bytes above the stack pointer");
        }
    }
    fo_line(&o);

    if (si->si_code > 0 && addr != pc) {
        fo_s(&o, "address ");
        fo_mapping(&o, &m[2]);
        fo_line(&o);
    }

    if (g_crumb.depth) { fo_s(&o, "inside "); fo_s(&o, g_crumb.fn); }
    else if (g_crumb.fn) { fo_s(&o, "not in a hook; last was "); fo_s(&o, g_crumb.fn); }
    else fo_s(&o, "not in a hook; none entered on this thread");
    if (g_crumb.fn && g_crumb.pathseq == g_crumb.seq) { fo_s(&o, "(\""); fo_s(&o, g_crumb.path); fo_s(&o, "\")"); }
    if (g_crumb.depth) { fo_s(&o, " (depth "); fo_u(&o, g_crumb.depth); fo_s(&o, ")"); }
    if (g_crumb.p9) { fo_s(&o, ", waiting on 9P "); fo_s(&o, g_crumb.p9); }
    fo_line(&o);

    for (int i = 0; i < frames; i++) {
        fo_s(&o, "frame ");
        fo_u(&o, (unsigned long)(i + 1));
        fo_s(&o, " ");
        fo_mapping(&o, &m[3 + i]);
        fo_line(&o);
    }
}

/* Die by `sig` with the default action: a kernel fault re-faults on return, a sent one is re-sent. */
static void fault_default(int sig, siginfo_t *si) {
    struct sigaction dfl;
    memset(&dfl, 0, sizeof dfl);
    dfl.sa_handler = SIG_DFL;
    g_real_sigaction(sig, &dfl, NULL);
    if (si->si_code <= 0) g_syscall(SYS_tgkill, g_syscall(SYS_getpid), g_syscall(SYS_gettid), sig);
}

static void fault_handler(int sig, siginfo_t *si, void *uc) {
    int saved = errno;
    if (g_wasm_trap && g_wasm_trap(sig, si, uc)) { errno = saved; return; }
    const struct sigaction *app = &g_app[sig == SIGBUS];
    int handled = (app->sa_flags & SA_SIGINFO) ? app->sa_sigaction != NULL
                                               : app->sa_handler != SIG_DFL && app->sa_handler != SIG_IGN;
    /* Only a fatal fault the kernel raised is reported. A sent SIGSEGV is the program's to interpret,
     * and a program's own handler may recover (a JVM's implicit null checks) unless it is node's,
     * which dies once V8 has turned the fault down. */
    if (si->si_code > 0 && !g_faulting && (!handled || g_wasm_trap)) {
        g_faulting = 1;
        fault_report(sig, si, (ucontext_t *)uc);
    }
    if (!handled) fault_default(sig, si);
    else if (app->sa_flags & SA_SIGINFO) app->sa_sigaction(sig, si, uc);
    else app->sa_handler(sig);
    errno = saved;
}

/* ---- alternate stacks ---------------------------------------------------------- */

#define FAULT_ALTSTACK (64 * 1024)

/* The alternate stack the handler runs on: without one a thread that overflowed its stack dies before
 * the handler can run. Mapped per thread, unmapped by the thread-specific destructor. */
static void *altstack_on(void) {
    void *mem = mmap(NULL, FAULT_ALTSTACK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mem == MAP_FAILED) return NULL;
    stack_t ss = { .ss_sp = mem, .ss_size = FAULT_ALTSTACK, .ss_flags = 0 };
    if (sigaltstack(&ss, NULL) < 0) { munmap(mem, FAULT_ALTSTACK); return NULL; }
    return mem;
}
static void altstack_off(void *mem) {
    stack_t ss = { .ss_sp = NULL, .ss_size = 0, .ss_flags = SS_DISABLE };
    sigaltstack(&ss, NULL);
    munmap(mem, FAULT_ALTSTACK);
}

/* pthread_key_create and pthread_setspecific are looked up, not linked: glibc 2.34 moved them into
 * libc under GLIBC_2.34, which older glibc does not have (native/symbols.sh). Without them a thread's
 * alternate stack outlives it. */
static pthread_key_t g_altstack_key;
static int (*g_setspecific)(pthread_key_t, const void *);

static void altstack_thread(void) {
    void *mem = altstack_on();
    if (mem && g_setspecific) g_setspecific(g_altstack_key, mem);
}

/* ---- install --------------------------------------------------------------------- */

static int fault_owns(int sig) { return g_fault_on && !g_faulting && (sig == SIGSEGV || sig == SIGBUS); }

/* Record `act` as the program's action for `sig` (ours stays installed) and report the previous one. */
static void fault_record(int sig, const struct sigaction *act, struct sigaction *old) {
    struct sigaction *app = &g_app[sig == SIGBUS];
    if (old) *old = *app;
    if (act) *app = *act;
    /* v8::TryHandleWebAssemblyTrapPosix: present in a node binary, which installs its handler here. */
    if (!g_wasm_trap)
        g_wasm_trap = (_Bool (*)(int, siginfo_t *, void *))dlsym(RTLD_DEFAULT, "_ZN2v829TryHandleWebAssemblyTrapPosixEiP9siginfo_tPv");
}

static void fault_init(void) {
    const char *on = getenv("VFS_FAULT_REPORT");
    if (!on || strcmp(on, "1") != 0) return;
    g_syscall = (long (*)(long, ...))dlsym(RTLD_NEXT, "syscall");
    g_real_sigaction = (int (*)(int, const struct sigaction *, struct sigaction *))dlsym(RTLD_NEXT, "sigaction");
    if (!g_syscall || !g_real_sigaction) return;

    int (*key_create)(pthread_key_t *, void (*)(void *)) =
        (int (*)(pthread_key_t *, void (*)(void *)))dlsym(RTLD_DEFAULT, "pthread_key_create");
    g_setspecific = (int (*)(pthread_key_t, const void *))dlsym(RTLD_DEFAULT, "pthread_setspecific");
    if (!key_create || key_create(&g_altstack_key, altstack_off) != 0) g_setspecific = NULL;

    altstack_on();   /* the main thread's; it lives as long as the process */
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = fault_handler;
    sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigfillset(&sa.sa_mask);
    if (g_real_sigaction(SIGSEGV, &sa, &g_app[0]) < 0) return;
    if (g_real_sigaction(SIGBUS, &sa, &g_app[1]) < 0) { g_real_sigaction(SIGSEGV, &g_app[0], NULL); return; }
    g_fault_on = 1;
}

#endif
