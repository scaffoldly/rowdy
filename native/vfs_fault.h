/*
 * vfs_fault.h — what a preloaded process was doing when a fault killed it.
 *
 * Depends on nothing else here, so every layer can leave a breadcrumb: the hook a
 * thread is in (and its path) and the 9P request it is waiting on. When the process
 * dies of a SIGSEGV, SIGBUS, SIGILL or SIGFPE the kernel raised, the handler writes one
 * report to stderr, then lets the program's own handler run (node's checks for a
 * WebAssembly trap and otherwise dies by the signal) or dies by the signal itself, so
 * the exit status is unchanged:
 *
 *   rowdy-vfs: fatal SIGSEGV (signal 11, code 1 SEGV_MAPERR) at 0x0, tid 42, shim 53b947a
 *   rowdy-vfs: pc 0x7f…  r-xp /usr/local/bin/node+0x1a2b3c
 *   rowdy-vfs: sp 0x7f…  rw-p [stack]; fault address is 120 bytes below the stack pointer
 *   rowdy-vfs: regs rax=0x0 rbx=0x7f… rcx=… (every general register, then the error code)
 *   rowdy-vfs: code 0x7f…: 48 89 e5 [8b] 07 c3 …   (the bytes around pc, pc's bracketed)
 *   rowdy-vfs: inside scandir("/vfs/x") (depth 1), waiting on 9P Treaddir
 *   rowdy-vfs: thread 57: inside openat("/vfs/y") (depth 1), waiting on 9P Twalk
 *   rowdy-vfs: threads 12 registered, 2 inside a hook
 *   rowdy-vfs: frame 1 0x7f…  r-xp /lib/ld-musl-x86_64.so.1+0x5c1e0
 *   rowdy-vfs: stack sp+0x28 0x7f…  r-xp /usr/local/bin/node+0x9f00
 *
 * `frame` lines follow frame pointers, which musl and much of node are built without.
 * `stack` lines are every word just above the stack pointer that points into executable
 * memory: the return addresses frame pointers would have given, among stale ones. The
 * other threads are every thread inside a hook or waiting on 9P at that moment.
 *
 * The handler only makes raw system calls through libc's syscall(), resolved before
 * any fault: no allocation, no stdio, nothing that reaches our own hooks. It reads
 * memory only inside mappings /proc/self/maps says are readable.
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

/* The shim's commit, set by native/build.sh, so a report's offsets name an exact binary. */
#ifndef VFS_BUILD
#define VFS_BUILD "unknown"
#endif

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

/* ---- threads ------------------------------------------------------------------ */

/* Every live thread's breadcrumb, so a report can say what the other threads were doing. A slot
 * is claimed when the thread starts and released by the thread-specific destructor. */
#define FAULT_THREADS 256
static struct crumb *g_thread_crumb[FAULT_THREADS];
static long g_thread_tid[FAULT_THREADS];
static __thread int g_thread_slot = -1;

static long (*g_syscall)(long, ...);      /* libc's own, past our hook */

static void thread_register(void) {
    long tid = g_syscall(SYS_gettid);
    for (int i = 0; i < FAULT_THREADS; i++) {
        struct crumb *none = NULL;
        if (__atomic_compare_exchange_n(&g_thread_crumb[i], &none, &g_crumb, 0, __ATOMIC_ACQ_REL, __ATOMIC_RELAXED)) {
            __atomic_store_n(&g_thread_tid[i], tid, __ATOMIC_RELEASE);
            g_thread_slot = i;
            return;
        }
    }
}
static void thread_unregister(void) {
    if (g_thread_slot < 0) return;
    __atomic_store_n(&g_thread_tid[g_thread_slot], 0, __ATOMIC_RELEASE);
    __atomic_store_n(&g_thread_crumb[g_thread_slot], NULL, __ATOMIC_RELEASE);
    g_thread_slot = -1;
}

/* ---- report ------------------------------------------------------------------ */

static volatile sig_atomic_t g_faulting;  /* a fault is being reported: sigaction passes through */
static const int g_fault_sigs[] = { SIGSEGV, SIGBUS, SIGILL, SIGFPE };
#define FAULT_NSIGS ((int)(sizeof g_fault_sigs / sizeof g_fault_sigs[0]))
static struct sigaction g_app[FAULT_NSIGS];   /* the program's actions for them */
static int (*g_real_sigaction)(int, const struct sigaction *, struct sigaction *);
static _Bool (*g_wasm_trap)(int, siginfo_t *, void *);  /* v8::TryHandleWebAssemblyTrapPosix, a C++ bool */

static int fault_slot(int sig) {
    for (int i = 0; i < FAULT_NSIGS; i++) if (g_fault_sigs[i] == sig) return i;
    return -1;
}

#define FAULT_LINE 640

struct fault_out { char b[FAULT_LINE]; size_t n; };

static void fo_s(struct fault_out *o, const char *s) {
    while (s && *s && o->n < sizeof o->b - 1) o->b[o->n++] = *s++;
}
/* At most `max` characters: for text another thread may be rewriting. */
static void fo_sn(struct fault_out *o, const char *s, size_t max) {
    for (size_t i = 0; i < max && s[i] && o->n < sizeof o->b - 1; i++) o->b[o->n++] = s[i];
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
static void fo_byte(struct fault_out *o, unsigned char v) {
    if (o->n + 2 >= sizeof o->b) return;
    o->b[o->n++] = "0123456789abcdef"[v >> 4];
    o->b[o->n++] = "0123456789abcdef"[v & 15];
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

static const char *sig_name(int sig) {
    switch (sig) {
    case SIGSEGV: return "SIGSEGV";
    case SIGBUS: return "SIGBUS";
    case SIGILL: return "SIGILL";
    case SIGFPE: return "SIGFPE";
    default: return "signal";
    }
}
static const char *code_name(int sig, int code) {
    if (code == SI_USER) return "SI_USER";
    if (code == SI_TKILL) return "SI_TKILL";
    if (code == SI_QUEUE) return "SI_QUEUE";
    switch (sig) {
    case SIGSEGV: return code == SEGV_MAPERR ? "SEGV_MAPERR" : code == SEGV_ACCERR ? "SEGV_ACCERR" : "";
    case SIGBUS: return code == BUS_ADRALN ? "BUS_ADRALN" : code == BUS_ADRERR ? "BUS_ADRERR"
                      : code == BUS_OBJERR ? "BUS_OBJERR" : "";
    case SIGILL: return code == ILL_ILLOPC ? "ILL_ILLOPC" : code == ILL_ILLOPN ? "ILL_ILLOPN"
                      : code == ILL_ILLADR ? "ILL_ILLADR" : code == ILL_ILLTRP ? "ILL_ILLTRP"
                      : code == ILL_PRVOPC ? "ILL_PRVOPC" : code == ILL_PRVREG ? "ILL_PRVREG"
                      : code == ILL_COPROC ? "ILL_COPROC" : code == ILL_BADSTK ? "ILL_BADSTK" : "";
    case SIGFPE: return code == FPE_INTDIV ? "FPE_INTDIV" : code == FPE_INTOVF ? "FPE_INTOVF"
                      : code == FPE_FLTDIV ? "FPE_FLTDIV" : code == FPE_FLTOVF ? "FPE_FLTOVF"
                      : code == FPE_FLTUND ? "FPE_FLTUND" : code == FPE_FLTRES ? "FPE_FLTRES"
                      : code == FPE_FLTINV ? "FPE_FLTINV" : code == FPE_FLTSUB ? "FPE_FLTSUB" : "";
    default: return "";
    }
}

/* ---- /proc/self/maps ------------------------------------------------------------ */

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

/* "start-end perms": the rest of the line after them, or NULL for a malformed line. */
static const char *parse_range(const char *line, uintptr_t *start, uintptr_t *end, char perms[5]) {
    const char *p = line;
    *start = parse_hex(&p);
    if (*p++ != '-') return NULL;
    *end = parse_hex(&p);
    if (*p++ != ' ') return NULL;
    for (int i = 0; i < 4; i++) {
        if (!*p) return NULL;
        perms[i] = *p++;
    }
    perms[4] = '\0';
    if (*p++ != ' ') return NULL;
    return p;
}

/* "start-end perms offset dev inode   path" */
static void match_line(const char *line, struct mapping *m, int n) {
    uintptr_t start, end;
    char perms[5];
    const char *p = parse_range(line, &start, &end, perms);
    if (!p) return;
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
        memcpy(m[i].perms, perms, 5);
        size_t k = 0;
        while (p[k] && k < sizeof m[i].path - 1) { m[i].path[k] = p[k]; k++; }
        m[i].path[k] = '\0';
    }
}

/* Each line of /proc/self/maps, to `fn`. */
static void maps_each(void (*fn)(const char *line, void *ctx), void *ctx) {
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
            fn(line, ctx);
            len = 0;
        }
    }
    g_syscall(SYS_close, fd);
}

struct lookup { struct mapping *m; int n; };
static void lookup_line(const char *line, void *ctx) {
    struct lookup *l = ctx;
    match_line(line, l->m, l->n);
}
/* Fill in each mapping's line from /proc/self/maps, in one pass. */
static void lookup_maps(struct mapping *m, int n) {
    struct lookup l = { m, n };
    if (n > 0) maps_each(lookup_line, &l);
}

/* The executable mappings, for telling code pointers on the stack from data. */
#define FAULT_EXEC_MAX 512
struct exec_ranges { struct { uintptr_t start, end; } r[FAULT_EXEC_MAX]; int n; };
static void exec_line(const char *line, void *ctx) {
    struct exec_ranges *x = ctx;
    uintptr_t start, end;
    char perms[5];
    if (x->n < FAULT_EXEC_MAX && parse_range(line, &start, &end, perms) && perms[2] == 'x') {
        x->r[x->n].start = start;
        x->r[x->n].end = end;
        x->n++;
    }
}
static int is_code(const struct exec_ranges *x, uintptr_t v) {
    for (int i = 0; i < x->n; i++) if (v >= x->r[i].start && v < x->r[i].end) return 1;
    return 0;
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

static int readable(const struct mapping *m) { return m->found && m->perms[0] == 'r'; }

/* ---- registers, code, stack ----------------------------------------------------------- */

#if defined(__x86_64__)
static const char *const g_reg_names[] = {
    "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp", "r8", "r9", "r10", "r11",
    "r12", "r13", "r14", "r15", "rip", "eflags", "err", "trapno",
};
static const int g_reg_index[] = {
    REG_RAX, REG_RBX, REG_RCX, REG_RDX, REG_RSI, REG_RDI, REG_RBP, REG_RSP, REG_R8, REG_R9, REG_R10, REG_R11,
    REG_R12, REG_R13, REG_R14, REG_R15, REG_RIP, REG_EFL, REG_ERR, REG_TRAPNO,
};
#define FAULT_NREGS ((int)(sizeof g_reg_index / sizeof g_reg_index[0]))
static uintptr_t reg_value(const ucontext_t *uc, int i) { return (uintptr_t)uc->uc_mcontext.gregs[g_reg_index[i]]; }
static void fo_reg_name(struct fault_out *o, int i) { fo_s(o, g_reg_names[i]); }
#elif defined(__aarch64__)
#define FAULT_NREGS 34   /* x0-x30, sp, pc, pstate */
static uintptr_t reg_value(const ucontext_t *uc, int i) {
    if (i < 31) return (uintptr_t)uc->uc_mcontext.regs[i];
    return i == 31 ? (uintptr_t)uc->uc_mcontext.sp : i == 32 ? (uintptr_t)uc->uc_mcontext.pc : (uintptr_t)uc->uc_mcontext.pstate;
}
static void fo_reg_name(struct fault_out *o, int i) {
    if (i < 31) { fo_s(o, "x"); fo_u(o, (unsigned long)i); return; }
    fo_s(o, i == 31 ? "sp" : i == 32 ? "pc" : "pstate");
}
#else
#define FAULT_NREGS 0
static uintptr_t reg_value(const ucontext_t *uc, int i) { (void)uc; (void)i; return 0; }
static void fo_reg_name(struct fault_out *o, int i) { (void)o; (void)i; }
#endif

#define FAULT_REGS_PER_LINE 6

static void fo_regs(struct fault_out *o, const ucontext_t *uc) {
    for (int i = 0; i < FAULT_NREGS; i++) {
        if (i % FAULT_REGS_PER_LINE == 0) fo_s(o, "regs");
        fo_s(o, " ");
        fo_reg_name(o, i);
        fo_s(o, "=");
        fo_x(o, reg_value(uc, i));
        if (i % FAULT_REGS_PER_LINE == FAULT_REGS_PER_LINE - 1 || i == FAULT_NREGS - 1) fo_line(o);
    }
}

#define FAULT_CODE_AROUND 16

/* The bytes around pc, inside its mapping, which the caller checked is readable. */
__attribute__((no_sanitize_address))
static void fo_code(struct fault_out *o, const struct mapping *m, uintptr_t pc) {
    uintptr_t from = pc - m->start >= FAULT_CODE_AROUND ? pc - FAULT_CODE_AROUND : m->start;
    uintptr_t to = m->end - pc >= FAULT_CODE_AROUND ? pc + FAULT_CODE_AROUND : m->end;
    fo_s(o, "code ");
    fo_x(o, from);
    fo_s(o, ":");
    for (uintptr_t a = from; a < to; a++) {
        fo_s(o, a == pc ? " [" : " ");
        fo_byte(o, *(const volatile unsigned char *)a);
        if (a == pc) fo_s(o, "]");
    }
    fo_line(o);
}

#define FAULT_FRAMES 8

/* Return addresses by frame pointer, read only from inside the stack the thread is on: a frame
 * pointer that leaves it (code built without one) ends the walk instead of faulting again. */
__attribute__((no_sanitize_address))
static int walk_frames(uintptr_t fp, uintptr_t sp, uintptr_t end, struct mapping *out, int max) {
    int frames = 0;
    for (uintptr_t f = fp; frames < max; frames++) {
        if (f < sp || f % sizeof(uintptr_t) || f + 2 * sizeof(uintptr_t) > end) break;
        uintptr_t next = ((const volatile uintptr_t *)f)[0], ret = ((const volatile uintptr_t *)f)[1];
        if (!ret) break;
        out[frames].addr = ret;
        if (next <= f) { frames++; break; }
        f = next;
    }
    return frames;
}

#define FAULT_SCAN_BYTES (16 * 1024)
#define FAULT_SCAN_HITS 24

/* Words from sp up (inside its mapping) that point into executable memory: candidate return
 * addresses, with their offset from sp in `at`. */
__attribute__((no_sanitize_address))
static int scan_stack(uintptr_t sp, uintptr_t end, const struct exec_ranges *x, struct mapping *out,
                      uintptr_t *at, int max) {
    int n = 0;
    uintptr_t top = end - sp > FAULT_SCAN_BYTES ? sp + FAULT_SCAN_BYTES : end;
    uintptr_t a = (sp + sizeof(uintptr_t) - 1) & ~(uintptr_t)(sizeof(uintptr_t) - 1);
    for (; a + sizeof(uintptr_t) <= top && n < max; a += sizeof(uintptr_t)) {
        uintptr_t v = *(const volatile uintptr_t *)a;
        if (!is_code(x, v)) continue;
        out[n].addr = v;
        at[n] = a - sp;
        n++;
    }
    return n;
}

/* ---- the report ---------------------------------------------------------------------------- */

static void fo_crumb(struct fault_out *o, const struct crumb *c) {
    const char *fn = c->fn, *p9 = c->p9;
    unsigned depth = c->depth;
    if (depth && fn) { fo_s(o, "inside "); fo_s(o, fn); }
    else if (fn) { fo_s(o, "not in a hook; last was "); fo_s(o, fn); }
    else fo_s(o, "not in a hook; none entered on this thread");
    if (fn && c->pathseq == c->seq) { fo_s(o, "(\""); fo_sn(o, c->path, CRUMB_PATH); fo_s(o, "\")"); }
    if (depth) { fo_s(o, " (depth "); fo_u(o, depth); fo_s(o, ")"); }
    if (p9) { fo_s(o, ", waiting on 9P "); fo_s(o, p9); }
}

static void fo_threads(struct fault_out *o) {
    int registered = 0, busy = 0;
    for (int i = 0; i < FAULT_THREADS; i++) {
        const struct crumb *c = __atomic_load_n(&g_thread_crumb[i], __ATOMIC_ACQUIRE);
        if (!c) continue;
        registered++;
        if (c == &g_crumb || (!c->depth && !c->p9)) continue;
        busy++;
        fo_s(o, "thread ");
        fo_u(o, (unsigned long)__atomic_load_n(&g_thread_tid[i], __ATOMIC_ACQUIRE));
        fo_s(o, ": ");
        fo_crumb(o, c);
        fo_line(o);
    }
    fo_s(o, "threads ");
    fo_u(o, (unsigned long)registered);
    fo_s(o, " registered, ");
    fo_u(o, (unsigned long)busy);
    fo_s(o, " others inside a hook or waiting on 9P");
    fo_line(o);
}

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
    int memory = sig == SIGSEGV || sig == SIGBUS;

    struct mapping m[3];
    memset(m, 0, sizeof m);
    m[0].addr = pc;
    m[1].addr = sp;
    m[2].addr = addr;
    lookup_maps(m, 3);

    struct mapping frame[FAULT_FRAMES];
    memset(frame, 0, sizeof frame);
    int frames = readable(&m[1]) ? walk_frames(fp, sp, m[1].end, frame, FAULT_FRAMES) : 0;
    lookup_maps(frame, frames);

    struct exec_ranges code;
    code.n = 0;
    struct mapping hit[FAULT_SCAN_HITS];
    uintptr_t at[FAULT_SCAN_HITS];
    memset(hit, 0, sizeof hit);
    int hits = 0;
    if (readable(&m[1])) {
        maps_each(exec_line, &code);
        hits = scan_stack(sp, m[1].end, &code, hit, at, FAULT_SCAN_HITS);
        lookup_maps(hit, hits);
    }

    struct fault_out o = { .n = 0 };
    fo_s(&o, "rowdy-vfs: fatal ");
    fo_s(&o, sig_name(sig));
    fo_s(&o, " (signal ");
    fo_u(&o, (unsigned long)sig);
    fo_s(&o, ", code ");
    if (si->si_code < 0) { fo_s(&o, "-"); fo_u(&o, (unsigned long)-si->si_code); }
    else fo_u(&o, (unsigned long)si->si_code);
    const char *name = code_name(sig, si->si_code);
    if (*name) { fo_s(&o, " "); fo_s(&o, name); }
    fo_s(&o, ")");
    if (si->si_code > 0) { fo_s(&o, " at "); fo_x(&o, addr); }
    fo_s(&o, ", tid ");
    fo_u(&o, (unsigned long)g_syscall(SYS_gettid));
    fo_s(&o, ", shim ");
    fo_s(&o, VFS_BUILD);
    fo_line(&o);

    fo_s(&o, "pc ");
    fo_mapping(&o, &m[0]);
    fo_line(&o);

    fo_s(&o, "sp ");
    fo_mapping(&o, &m[1]);
    if (m[1].found && m[1].perms[0] == '-' && m[1].perms[1] == '-') fo_s(&o, "; in a guard page: stack overflow");
    if (memory && si->si_code > 0) {
        uintptr_t d = addr < sp ? sp - addr : addr - sp;
        if (d <= 1 << 20) {
            fo_s(&o, "; fault address is ");
            fo_u(&o, (unsigned long)d);
            fo_s(&o, addr < sp ? " bytes below the stack pointer" : " bytes above the stack pointer");
        }
    }
    fo_line(&o);

    if (memory && si->si_code > 0 && addr != pc) {
        fo_s(&o, "address ");
        fo_mapping(&o, &m[2]);
        fo_line(&o);
    }

    fo_regs(&o, uc);
    if (readable(&m[0])) fo_code(&o, &m[0], pc);

    fo_crumb(&o, &g_crumb);
    fo_line(&o);
    fo_threads(&o);

    for (int i = 0; i < frames; i++) {
        fo_s(&o, "frame ");
        fo_u(&o, (unsigned long)(i + 1));
        fo_s(&o, " ");
        fo_mapping(&o, &frame[i]);
        fo_line(&o);
    }
    for (int i = 0; i < hits; i++) {
        fo_s(&o, "stack sp+");
        fo_x(&o, at[i]);
        fo_s(&o, " ");
        fo_mapping(&o, &hit[i]);
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
    const struct sigaction *app = &g_app[fault_slot(sig)];
    int handled = (app->sa_flags & SA_SIGINFO) ? app->sa_sigaction != NULL
                                               : app->sa_handler != SIG_DFL && app->sa_handler != SIG_IGN;
    /* Only a fatal fault the kernel raised is reported. A sent signal is the program's to interpret,
     * and a program's own handler may recover (a JVM's implicit null checks, OpenSSL's SIGILL probe
     * of CPU features at startup) unless it is node's SIGSEGV handler, which dies once V8 has
     * turned the fault down. */
    if (si->si_code > 0 && !g_faulting && (!handled || (sig == SIGSEGV && g_wasm_trap))) {
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
#define FAULT_NO_ALTSTACK ((void *)1)   /* a thread-specific value that still runs the destructor */

/* The alternate stack the handler runs on: without one a thread that overflowed its stack dies before
 * the handler can run. Mapped per thread, unmapped by the thread-specific destructor. */
static void *altstack_on(void) {
    void *mem = mmap(NULL, FAULT_ALTSTACK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mem == MAP_FAILED) return NULL;
    stack_t ss = { .ss_sp = mem, .ss_size = FAULT_ALTSTACK, .ss_flags = 0 };
    if (sigaltstack(&ss, NULL) < 0) { munmap(mem, FAULT_ALTSTACK); return NULL; }
    return mem;
}

/* pthread_key_create and pthread_setspecific are looked up, not linked: glibc 2.34 moved them into
 * libc under GLIBC_2.34, which older glibc does not have (native/symbols.sh). Without them a thread's
 * alternate stack and registry slot outlive it. */
static pthread_key_t g_thread_key;
static int (*g_setspecific)(pthread_key_t, const void *);

static void thread_exit(void *mem) {
    thread_unregister();
    if (mem == FAULT_NO_ALTSTACK) return;
    stack_t ss = { .ss_sp = NULL, .ss_size = 0, .ss_flags = SS_DISABLE };
    sigaltstack(&ss, NULL);
    munmap(mem, FAULT_ALTSTACK);
}

/* A new thread, before its start routine: an alternate stack and a registry slot. */
static void thread_start(void) {
    void *mem = altstack_on();
    thread_register();
    if (g_setspecific) g_setspecific(g_thread_key, mem ? mem : FAULT_NO_ALTSTACK);
}

/* ---- install --------------------------------------------------------------------- */

static int fault_owns(int sig) { return g_fault_on && !g_faulting && fault_slot(sig) >= 0; }

/* Record `act` as the program's action for `sig` (ours stays installed) and report the previous one. */
static void fault_record(int sig, const struct sigaction *act, struct sigaction *old) {
    struct sigaction *app = &g_app[fault_slot(sig)];
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
    if (!key_create || key_create(&g_thread_key, thread_exit) != 0) g_setspecific = NULL;

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = fault_handler;
    sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigfillset(&sa.sa_mask);
    for (int i = 0; i < FAULT_NSIGS; i++) {
        if (g_real_sigaction(g_fault_sigs[i], &sa, &g_app[i]) == 0) continue;
        while (i--) g_real_sigaction(g_fault_sigs[i], &g_app[i], NULL);
        return;
    }
    altstack_on();      /* the main thread's; it lives as long as the process */
    thread_register();  /* likewise */
    g_fault_on = 1;
}

#endif
