/*
 * Unit tests for vfs_fault.h: the /proc/self/maps parser, the report's formatting, the breadcrumbs
 * (and that they are off unless VFS_FAULT_REPORT=1), and a whole report for a made-up fault.
 * Run by tests/native/unit.sh.
 */
#define _GNU_SOURCE
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <stdint.h>
#include <cmocka.h>
#include <stdio.h>
#include <unistd.h>

#include "vfs_fault.h"

#define assert_contains(haystack, needle)                                                       \
    do {                                                                                        \
        if (!strstr((haystack), (needle))) fail_msg("'%s' not in:\n%s", (needle), (haystack));  \
    } while (0)

/* ---- the report's syscalls: writes to stderr are kept, the rest go to the kernel ----------- */

static char g_written[8192];
static size_t g_nwritten;

static long fake_syscall(long n, ...) {
    va_list ap;
    va_start(ap, n);
    long r;
    if (n == SYS_write) {
        int fd = va_arg(ap, int);
        const char *buf = va_arg(ap, const char *);
        size_t len = va_arg(ap, size_t);
        if (fd != 2) {
            r = syscall(SYS_write, fd, buf, len);   /* the report file */
            va_end(ap);
            return r;
        }
        if (g_nwritten + len < sizeof g_written) {
            memcpy(g_written + g_nwritten, buf, len);
            g_nwritten += len;
            g_written[g_nwritten] = '\0';
        }
        r = (long)len;
    } else if (n == SYS_openat) {
        int dirfd = va_arg(ap, int);
        const char *path = va_arg(ap, const char *);
        int flags = va_arg(ap, int);
        mode_t mode = (flags & O_CREAT) ? (mode_t)va_arg(ap, int) : 0;
        r = syscall(SYS_openat, dirfd, path, flags, mode);
    } else if (n == SYS_read) {
        int fd = va_arg(ap, int);
        void *buf = va_arg(ap, void *);
        size_t len = va_arg(ap, size_t);
        r = syscall(SYS_read, fd, buf, len);
    } else if (n == SYS_close) {
        r = syscall(SYS_close, va_arg(ap, int));
    } else if (n == SYS_gettid) {
        r = syscall(SYS_gettid);
    } else if (n == SYS_getpid) {
        r = syscall(SYS_getpid);
    } else {
        fail_msg("unexpected syscall %ld", n);
        r = -1;
    }
    va_end(ap);
    return r;
}

static int reset(void **state) {
    (void)state;
    memset(&g_crumb, 0, sizeof g_crumb);
    memset(g_thread_crumb, 0, sizeof g_thread_crumb);
    memset(g_thread_tid, 0, sizeof g_thread_tid);
    g_thread_slot = -1;
    g_fault_file[0] = '\0';
    g_fault_fd = -1;
    g_fault_on = 1;
    g_syscall = fake_syscall;
    g_nwritten = 0;
    g_written[0] = '\0';
    return 0;
}

/* ---- /proc/self/maps --------------------------------------------------------------------- */

static void parse_hex_stops_at_the_first_non_digit(void **state) {
    (void)state;
    const char *p = "7f12ab-7f12ff";
    assert_int_equal(parse_hex(&p), 0x7f12ab);
    assert_int_equal(*p, '-');
}

static void match_line_reads_a_file_mapping(void **state) {
    (void)state;
    struct mapping m = { .addr = 0x55d0a100 };
    match_line("55d0a000-55d0b000 r-xp 00001000 08:01 123                       /usr/bin/node", &m, 1);
    assert_true(m.found);
    assert_int_equal(m.start, 0x55d0a000);
    assert_int_equal(m.end, 0x55d0b000);
    assert_int_equal(m.offset, 0x1000);
    assert_string_equal(m.perms, "r-xp");
    assert_string_equal(m.path, "/usr/bin/node");
}

static void match_line_reads_anonymous_stack_and_spaced_paths(void **state) {
    (void)state;
    struct mapping m[3] = { { .addr = 0x7ffd0010 }, { .addr = 0x7ffe0010 }, { .addr = 0x10010 } };
    match_line("7ffd0000-7ffd1000 rw-p 00000000 00:00 0 ", m, 3);
    match_line("7ffe0000-7ffe1000 rw-p 00000000 00:00 0                          [stack]", m, 3);
    match_line("00010000-00011000 r--p 00000000 08:01 9   /tmp/my file (deleted)", m, 3);
    assert_true(m[0].found);
    assert_string_equal(m[0].path, "");
    assert_string_equal(m[1].path, "[stack]");
    assert_string_equal(m[2].path, "/tmp/my file (deleted)");
}

static void match_line_leaves_addresses_outside_it_and_keeps_the_first_match(void **state) {
    (void)state;
    struct mapping m[2] = { { .addr = 0x2000 }, { .addr = 0x1000 } };
    match_line("00001000-00002000 r-xp 00000000 08:01 1 /a", m, 2);   /* end is exclusive */
    match_line("00001000-00002000 r-xp 00000000 08:01 1 /b", m, 2);
    assert_false(m[0].found);
    assert_string_equal(m[1].path, "/a");
}

static void match_line_ignores_a_malformed_line(void **state) {
    (void)state;
    struct mapping m = { .addr = 0x1000 };
    match_line("garbage", &m, 1);
    match_line("00001000 r-xp", &m, 1);
    match_line("00001000-00002000 r", &m, 1);   /* truncated in the permissions */
    match_line("", &m, 1);
    assert_false(m.found);
}

static void lookup_maps_finds_this_function_in_this_binary(void **state) {
    (void)state;
    struct mapping m = { .addr = (uintptr_t)&lookup_maps_finds_this_function_in_this_binary };
    lookup_maps(&m, 1);
    assert_true(m.found);
    assert_int_equal(m.perms[2], 'x');
    assert_contains(m.path, "test_fault");
}

/* ---- formatting -------------------------------------------------------------------------- */

static void formats_numbers(void **state) {
    (void)state;
    struct fault_out o = { .n = 0 };
    fo_x(&o, 0);
    fo_s(&o, " ");
    fo_x(&o, 0xdeadbeef);
    fo_s(&o, " ");
    fo_u(&o, 0);
    fo_s(&o, " ");
    fo_u(&o, 1234567890);
    o.b[o.n] = '\0';
    assert_string_equal(o.b, "0x0 0xdeadbeef 0 1234567890");
}

static void formatting_stops_at_the_end_of_the_line(void **state) {
    (void)state;
    struct fault_out o = { .n = 0 };
    for (int i = 0; i < 2 * FAULT_LINE; i++) fo_s(&o, "x");
    fo_u(&o, 123);
    fo_x(&o, 0xabc);
    assert_int_equal(o.n, sizeof o.b - 1);   /* one left for fo_line's newline */
}

static void formats_a_mapping(void **state) {
    (void)state;
    struct fault_out o = { .n = 0 };
    struct mapping file = { .addr = 0x1100, .start = 0x1000, .end = 0x2000, .offset = 0x4000, .found = 1 };
    strcpy(file.perms, "r-xp");
    strcpy(file.path, "/usr/bin/node");
    fo_mapping(&o, &file);
    o.b[o.n] = '\0';
    assert_string_equal(o.b, "0x1100  r-xp /usr/bin/node+0x4100");

    o.n = 0;
    struct mapping anon = { .addr = 0x1100, .start = 0x1000, .end = 0x2000, .found = 1 };
    strcpy(anon.perms, "rwxp");
    fo_mapping(&o, &anon);
    o.b[o.n] = '\0';
    assert_string_equal(o.b, "0x1100  rwxp [anonymous] 0x1000-0x2000");

    o.n = 0;
    struct mapping none = { .addr = 0x10 };
    fo_mapping(&o, &none);
    o.b[o.n] = '\0';
    assert_string_equal(o.b, "0x10  (not mapped)");
}

static void names_signal_codes(void **state) {
    (void)state;
    assert_string_equal(code_name(SIGSEGV, SEGV_MAPERR), "SEGV_MAPERR");
    assert_string_equal(code_name(SIGSEGV, SEGV_ACCERR), "SEGV_ACCERR");
    assert_string_equal(code_name(SIGBUS, BUS_ADRALN), "BUS_ADRALN");
    assert_string_equal(code_name(SIGSEGV, SI_USER), "SI_USER");
    assert_string_equal(code_name(SIGSEGV, 99), "");
    assert_string_equal(sig_name(SIGBUS), "SIGBUS");
}

/* ---- breadcrumbs ------------------------------------------------------------------------- */

static void crumbs_are_off_unless_the_report_is_on(void **state) {
    (void)state;
    g_fault_on = 0;
    {
        CRUMB("openat");
        crumb_path("/vfs/a");
        CRUMB_P9("Twalk");
        assert_null(g_crumb.fn);
        assert_int_equal(g_crumb.depth, 0);
        assert_null(g_crumb.p9);
        assert_string_equal(g_crumb.path, "");
    }
}

static void crumbs_follow_nested_hooks_and_leave_with_them(void **state) {
    (void)state;
    {
        CRUMB("scandir");
        crumb_path("/vfs/d");
        {
            CRUMB("readlink");
            assert_int_equal(g_crumb.depth, 2);
            assert_string_equal(g_crumb.fn, "readlink");
            assert_true(g_crumb.pathseq != g_crumb.seq);   /* the path was scandir's */
            {
                CRUMB_P9("Treaddir");
                assert_string_equal(g_crumb.p9, "Treaddir");
            }
            assert_null(g_crumb.p9);
        }
        assert_int_equal(g_crumb.depth, 1);
    }
    assert_int_equal(g_crumb.depth, 0);
}

static void crumb_path_is_truncated(void **state) {
    (void)state;
    char long_path[2 * CRUMB_PATH];
    memset(long_path, 'a', sizeof long_path - 1);
    long_path[sizeof long_path - 1] = '\0';
    CRUMB("open");
    crumb_path(long_path);
    assert_int_equal(strlen(g_crumb.path), CRUMB_PATH - 1);
    assert_int_equal(g_crumb.pathseq, g_crumb.seq);
}

/* ---- a whole report ---------------------------------------------------------------------- */

static void return_here(void) {}

static void set_context(ucontext_t *uc, uintptr_t pc, uintptr_t sp, uintptr_t fp) {
    memset(uc, 0, sizeof *uc);
#if defined(__x86_64__)
    uc->uc_mcontext.gregs[REG_RIP] = (greg_t)pc;
    uc->uc_mcontext.gregs[REG_RSP] = (greg_t)sp;
    uc->uc_mcontext.gregs[REG_RBP] = (greg_t)fp;
#elif defined(__aarch64__)
    uc->uc_mcontext.pc = pc;
    uc->uc_mcontext.sp = sp;
    uc->uc_mcontext.regs[29] = fp;
#endif
}

static void reports_a_fault_inside_a_hook(void **state) {
    (void)state;
    /* One frame: a frame record on this stack whose return address is in this binary. */
    uintptr_t frame[2] = { 0, (uintptr_t)&return_here };
    siginfo_t si;
    memset(&si, 0, sizeof si);
    si.si_signo = SIGSEGV;
    si.si_code = SEGV_MAPERR;
    si.si_addr = NULL;
    ucontext_t uc;
    set_context(&uc, (uintptr_t)&reports_a_fault_inside_a_hook, (uintptr_t)frame - 64, (uintptr_t)frame);

    CRUMB("openat");
    crumb_path("/vfs/a");
    CRUMB_P9("Twalk");
    fault_report(SIGSEGV, &si, &uc);

    assert_contains(g_written, "rowdy-vfs: fatal SIGSEGV (signal 11, code 1 SEGV_MAPERR) at 0x0, pid ");
    assert_contains(g_written, "\nrowdy-vfs: pc 0x");
    assert_contains(g_written, "/test_fault+0x");
    /* The stack's mapping: "[stack]" natively, a plain anonymous mapping under emulation. */
    const char *sp = strstr(g_written, "\nrowdy-vfs: sp 0x");
    assert_non_null(sp);
    assert_contains(sp, "  rw-p ");
    assert_contains(g_written, "\nrowdy-vfs: address 0x0  (not mapped)");
    assert_contains(g_written, "\nrowdy-vfs: inside openat(\"/vfs/a\") (depth 1), waiting on 9P Twalk\n");
    assert_contains(g_written, "\nrowdy-vfs: frame 1 0x");
    assert_contains(g_written, "\nrowdy-vfs: regs ");
    assert_contains(g_written, "\nrowdy-vfs: code 0x");
    assert_contains(g_written, "\nrowdy-vfs: threads 0 registered, 0 others inside a hook or waiting on 9P\n");
    /* the frame record's return address is in this binary, so the scan finds it too */
    assert_contains(g_written, "\nrowdy-vfs: stack sp+0x48 0x");
    assert_contains(g_written, ", shim unknown\n");
}

/* ---- the pieces of the report ------------------------------------------------------------- */

static void parse_range_reads_bounds_and_permissions(void **state) {
    (void)state;
    uintptr_t start, end;
    char perms[5];
    const char *rest = parse_range("1000-2000 r-xp 0 08:01 1 /a", &start, &end, perms);
    assert_non_null(rest);
    assert_int_equal(start, 0x1000);
    assert_int_equal(end, 0x2000);
    assert_string_equal(perms, "r-xp");
    assert_string_equal(rest, "0 08:01 1 /a");
    assert_null(parse_range("1000-2000 r", &start, &end, perms));
}

static void exec_ranges_keep_only_executable_mappings(void **state) {
    (void)state;
    struct exec_ranges x = { .n = 0 };
    exec_line("1000-2000 r-xp 0 08:01 1 /bin/node", &x);
    exec_line("2000-3000 rw-p 0 00:00 0", &x);
    exec_line("4000-5000 rwxp 0 00:00 0", &x);   /* JIT */
    exec_line("garbage", &x);
    assert_int_equal(x.n, 2);
    assert_true(is_code(&x, 0x1000));
    assert_false(is_code(&x, 0x2000));
    assert_true(is_code(&x, 0x4fff));
    assert_false(is_code(&x, 0x5000));
}

static void the_stack_scan_finds_code_pointers_above_sp_and_stops_at_the_mapping(void **state) {
    (void)state;
    uintptr_t words[8] = { 7, 0x1100, 9, 0x1200, 0x4100, 11, 0x1300, 0x1400 };
    struct exec_ranges x = { .n = 0 };
    exec_line("1000-2000 r-xp 0 08:01 1 /bin/node", &x);
    exec_line("4000-5000 rwxp 0 00:00 0", &x);
    struct mapping hit[3];
    uintptr_t at[3];
    memset(hit, 0, sizeof hit);
    uintptr_t sp = (uintptr_t)&words[1], end = (uintptr_t)&words[7];   /* words[7] is past the mapping */
    int n = scan_stack(sp, end, &x, hit, at, 3);
    assert_int_equal(n, 3);
    assert_int_equal(hit[0].addr, 0x1100);
    assert_int_equal(at[0], 0);
    assert_int_equal(hit[1].addr, 0x1200);
    assert_int_equal(at[1], 2 * sizeof(uintptr_t));
    assert_int_equal(hit[2].addr, 0x4100);
    n = scan_stack(sp, end, &x, hit, at, 2);   /* bounded by max too */
    assert_int_equal(n, 2);
}

static void the_frame_walk_follows_records_and_stops_outside_the_stack(void **state) {
    (void)state;
    uintptr_t stack[8] = { 0 };
    /* two records: stack[2] -> stack[4] -> outside (0) */
    stack[2] = (uintptr_t)&stack[4];
    stack[3] = 0xaaa;
    stack[4] = 0;
    stack[5] = 0xbbb;
    struct mapping out[4];
    memset(out, 0, sizeof out);
    int n = walk_frames((uintptr_t)&stack[2], (uintptr_t)&stack[0], (uintptr_t)&stack[8], out, 4);
    assert_int_equal(n, 2);
    assert_int_equal(out[0].addr, 0xaaa);
    assert_int_equal(out[1].addr, 0xbbb);
    assert_int_equal(walk_frames(0, (uintptr_t)&stack[0], (uintptr_t)&stack[8], out, 4), 0);   /* below sp */
    assert_int_equal(walk_frames((uintptr_t)&stack[7], (uintptr_t)&stack[0], (uintptr_t)&stack[8], out, 4), 0);
}

static void registers_are_all_printed_by_name(void **state) {
    (void)state;
    ucontext_t uc;
    set_context(&uc, 0x1234, 0x5678, 0x9abc);
    struct fault_out o = { .n = 0 };
    fo_regs(&o, &uc);
#if defined(__x86_64__)
    assert_contains(g_written, "regs rax=0x0 rbx=0x0");
    assert_contains(g_written, " rip=0x1234");
    assert_contains(g_written, " rsp=0x5678");
    assert_contains(g_written, " trapno=0x0\n");
#elif defined(__aarch64__)
    assert_contains(g_written, "regs x0=0x0 x1=0x0");
    assert_contains(g_written, " x29=0x9abc");
    assert_contains(g_written, " sp=0x5678 pc=0x1234 pstate=0x0\n");
#endif
}

static void code_bytes_bracket_pc_and_stay_inside_the_mapping(void **state) {
    (void)state;
    static const unsigned char bytes[8] = { 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80 };
    struct mapping m = { .start = (uintptr_t)bytes, .end = (uintptr_t)bytes + sizeof bytes, .found = 1 };
    strcpy(m.perms, "r--p");
    struct fault_out o = { .n = 0 };
    fo_code(&o, &m, (uintptr_t)&bytes[2]);
    assert_contains(g_written, ": 10 20 [30] 40 50 60 70 80\n");
}

static void signal_codes_for_illegal_instructions_and_arithmetic(void **state) {
    (void)state;
    assert_string_equal(sig_name(SIGILL), "SIGILL");
    assert_string_equal(sig_name(SIGFPE), "SIGFPE");
    assert_string_equal(code_name(SIGILL, ILL_ILLOPC), "ILL_ILLOPC");
    assert_string_equal(code_name(SIGILL, ILL_ILLOPN), "ILL_ILLOPN");
    assert_string_equal(code_name(SIGFPE, FPE_INTDIV), "FPE_INTDIV");
    assert_string_equal(code_name(SIGFPE, FPE_FLTINV), "FPE_FLTINV");
    assert_int_equal(fault_slot(SIGFPE), 3);
    assert_int_equal(fault_slot(SIGABRT), -1);
}

static void bounded_text_stops_without_a_terminator(void **state) {
    (void)state;
    char unterminated[4] = { 'a', 'b', 'c', 'd' };
    struct fault_out o = { .n = 0 };
    fo_sn(&o, unterminated, sizeof unterminated);
    o.b[o.n] = '\0';
    assert_string_equal(o.b, "abcd");
}

static void the_report_is_appended_to_vfs_fault_file_too(void **state) {
    (void)state;
    char path[] = "/tmp/vfsunit-report-XXXXXX";
    int tmp = mkstemp(path);
    assert_true(tmp >= 0);
    close(tmp);
    strcpy(g_fault_file, path);
    siginfo_t si;
    memset(&si, 0, sizeof si);
    si.si_signo = SIGSEGV;
    si.si_code = SEGV_MAPERR;
    ucontext_t uc;
    int here;
    set_context(&uc, (uintptr_t)&the_report_is_appended_to_vfs_fault_file_too, (uintptr_t)&here, 0);
    fault_report(SIGSEGV, &si, &uc);
    fault_report(SIGSEGV, &si, &uc);   /* a second crash appends */
    assert_int_equal(g_fault_fd, -1);   /* closed after each report */

    static char file[2 * sizeof g_written];
    FILE *f = fopen(path, "r");
    assert_non_null(f);
    size_t n = fread(file, 1, sizeof file - 1, f);
    fclose(f);
    unlink(path);
    file[n] = '\0';
    assert_int_equal(n, g_nwritten);
    assert_memory_equal(file, g_written, n);   /* the same bytes as stderr */
    char *second = strstr(file + 1, "rowdy-vfs: fatal SIGSEGV");
    assert_non_null(second);
}

/* A second thread inside a hook, waiting on 9P, while this one reports. */
static pthread_mutex_t g_gate = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_cond = PTHREAD_COND_INITIALIZER;
static int g_stage;
static long g_other_tid;

static void *busy_thread(void *arg) {
    (void)arg;
    thread_register();
    CRUMB("openat");
    crumb_path("/vfs/other");
    CRUMB_P9("Tlopen");
    pthread_mutex_lock(&g_gate);
    g_other_tid = syscall(SYS_gettid);
    g_stage = 1;
    pthread_cond_broadcast(&g_cond);
    while (g_stage != 2) pthread_cond_wait(&g_cond, &g_gate);
    pthread_mutex_unlock(&g_gate);
    thread_unregister();
    return NULL;
}

static void other_threads_inside_hooks_are_listed(void **state) {
    (void)state;
    thread_register();
    pthread_t t;
    g_stage = 0;
    assert_int_equal(pthread_create(&t, NULL, busy_thread, NULL), 0);
    pthread_mutex_lock(&g_gate);
    while (g_stage != 1) pthread_cond_wait(&g_cond, &g_gate);
    pthread_mutex_unlock(&g_gate);

    struct fault_out o = { .n = 0 };
    fo_threads(&o);
    char want[96];
    snprintf(want, sizeof want, "thread %ld: inside openat(\"/vfs/other\") (depth 1), waiting on 9P Tlopen\n", g_other_tid);
    assert_contains(g_written, want);
    assert_contains(g_written, "threads 2 registered, 1 others inside a hook or waiting on 9P\n");

    pthread_mutex_lock(&g_gate);
    g_stage = 2;
    pthread_cond_broadcast(&g_cond);
    pthread_mutex_unlock(&g_gate);
    pthread_join(t, NULL);
    thread_unregister();
    assert_null(g_thread_crumb[0]);
}

static void reports_a_thread_outside_any_hook(void **state) {
    (void)state;
    siginfo_t si;
    memset(&si, 0, sizeof si);
    si.si_signo = SIGBUS;
    si.si_code = BUS_ADRERR;
    si.si_addr = (void *)0x10;
    ucontext_t uc;
    int here;
    set_context(&uc, (uintptr_t)&reports_a_thread_outside_any_hook, (uintptr_t)&here, 0);
    fault_report(SIGBUS, &si, &uc);
    assert_contains(g_written, "rowdy-vfs: fatal SIGBUS (signal 7, code 2 BUS_ADRERR) at 0x10, pid ");
    assert_contains(g_written, "\nrowdy-vfs: not in a hook; none entered on this thread\n");
    assert_null(strstr(g_written, "frame 1"));
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test_setup(parse_hex_stops_at_the_first_non_digit, reset),
        cmocka_unit_test_setup(match_line_reads_a_file_mapping, reset),
        cmocka_unit_test_setup(match_line_reads_anonymous_stack_and_spaced_paths, reset),
        cmocka_unit_test_setup(match_line_leaves_addresses_outside_it_and_keeps_the_first_match, reset),
        cmocka_unit_test_setup(match_line_ignores_a_malformed_line, reset),
        cmocka_unit_test_setup(lookup_maps_finds_this_function_in_this_binary, reset),
        cmocka_unit_test_setup(formats_numbers, reset),
        cmocka_unit_test_setup(formatting_stops_at_the_end_of_the_line, reset),
        cmocka_unit_test_setup(formats_a_mapping, reset),
        cmocka_unit_test_setup(names_signal_codes, reset),
        cmocka_unit_test_setup(crumbs_are_off_unless_the_report_is_on, reset),
        cmocka_unit_test_setup(crumbs_follow_nested_hooks_and_leave_with_them, reset),
        cmocka_unit_test_setup(crumb_path_is_truncated, reset),
        cmocka_unit_test_setup(reports_a_fault_inside_a_hook, reset),
        cmocka_unit_test_setup(reports_a_thread_outside_any_hook, reset),
        cmocka_unit_test_setup(parse_range_reads_bounds_and_permissions, reset),
        cmocka_unit_test_setup(exec_ranges_keep_only_executable_mappings, reset),
        cmocka_unit_test_setup(the_stack_scan_finds_code_pointers_above_sp_and_stops_at_the_mapping, reset),
        cmocka_unit_test_setup(the_frame_walk_follows_records_and_stops_outside_the_stack, reset),
        cmocka_unit_test_setup(registers_are_all_printed_by_name, reset),
        cmocka_unit_test_setup(code_bytes_bracket_pc_and_stay_inside_the_mapping, reset),
        cmocka_unit_test_setup(signal_codes_for_illegal_instructions_and_arithmetic, reset),
        cmocka_unit_test_setup(bounded_text_stops_without_a_terminator, reset),
        cmocka_unit_test_setup(other_threads_inside_hooks_are_listed, reset),
        cmocka_unit_test_setup(the_report_is_appended_to_vfs_fault_file_too, reset),
    };
    return cmocka_run_group_tests_name("vfs_fault.h", tests, NULL, NULL);
}
