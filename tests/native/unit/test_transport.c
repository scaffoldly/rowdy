/*
 * Unit tests for vfs_transport.h: 9P message encoding and decoding, tags, and the message names the
 * fault report's breadcrumb shows. Run by tests/native/unit.sh.
 */
#define _GNU_SOURCE
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <stdint.h>
#include <cmocka.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "vfs_fault.h"
#include "vfs_transport.h"

static void begin_writes_a_header_whose_size_is_filled_in_later(void **state) {
    (void)state;
    unsigned char mem[64];
    struct p9buf b;
    begin(&b, mem, sizeof mem, Twalk, 0x1234);
    assert_int_equal(b.len, 7);
    assert_int_equal(b.err, 0);
    assert_int_equal(get32(mem), 0);
    assert_int_equal(mem[4], Twalk);
    assert_int_equal(get16(mem + 5), 0x1234);
}

static void integers_are_little_endian(void **state) {
    (void)state;
    unsigned char mem[16];
    struct p9buf b = { .p = mem, .len = 0, .cap = sizeof mem, .err = 0 };
    put16(&b, 0xbeef);
    put32(&b, 0xdeadbeef);
    put64(&b, 0x0102030405060708ULL);
    assert_int_equal(b.len, 14);
    const unsigned char want[] = { 0xef, 0xbe, 0xef, 0xbe, 0xad, 0xde, 8, 7, 6, 5, 4, 3, 2, 1 };
    assert_memory_equal(mem, want, sizeof want);
    assert_int_equal(get16(mem), 0xbeef);
    assert_int_equal(get32(mem + 2), 0xdeadbeef);
}

static void strings_are_length_prefixed(void **state) {
    (void)state;
    unsigned char mem[16];
    struct p9buf b = { .p = mem, .len = 0, .cap = sizeof mem, .err = 0 };
    puts9(&b, "oauth", 5);
    assert_int_equal(b.len, 7);
    assert_int_equal(get16(mem), 5);
    assert_memory_equal(mem + 2, "oauth", 5);
}

static void overflowing_the_buffer_is_an_error_not_a_write(void **state) {
    (void)state;
    unsigned char mem[8] = { 0 };   /* AddressSanitizer fails the run on a write past it */
    struct p9buf b = { .p = mem, .len = 0, .cap = 4, .err = 0 };
    put64(&b, ~0ULL);
    assert_int_equal(b.err, 1);
    assert_int_equal(b.len, 4);

    struct p9buf s = { .p = mem, .len = 0, .cap = sizeof mem, .err = 0 };
    puts9(&s, "0123456789", 10);   /* 2 + 10 > 8 */
    assert_int_equal(s.err, 1);
    assert_int_equal(s.len, 2);    /* the length went in, the bytes did not */

    struct p9buf l = { .p = mem, .len = 0, .cap = sizeof mem, .err = 0 };
    puts9(&l, "", 0x10000);   /* longer than a 9P string can say */
    assert_int_equal(l.err, 1);
    assert_int_equal(l.len, 0);
}

static void tags_wrap_around_the_reserved_notag(void **state) {
    (void)state;
    g_tag = P9_NOTAG - 2;
    assert_int_equal(nexttag(), P9_NOTAG - 1);
    assert_int_equal(nexttag(), 1);
    assert_int_equal(nexttag(), 2);
}

static void names_each_message_the_shim_sends(void **state) {
    (void)state;
    assert_string_equal(p9_name(Twalk), "Twalk");
    assert_string_equal(p9_name(Tlopen), "Tlopen");
    assert_string_equal(p9_name(Treaddir), "Treaddir");
    assert_string_equal(p9_name(Tlock), "Tlock");
    assert_string_equal(p9_name(Tclunk), "Tclunk");
    assert_string_equal(p9_name(Trenameat), "Trenameat");
    assert_string_equal(p9_name(0), "T?");
}

static void a_call_without_a_socket_is_enotconn(void **state) {
    (void)state;
    g_socket = NULL;
    unsigned char reply[64];
    errno = 0;
    assert_int_equal(p9_call(Tclunk, NULL, NULL, reply, sizeof reply), -1);
    assert_int_equal(errno, ENOTCONN);
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(begin_writes_a_header_whose_size_is_filled_in_later),
        cmocka_unit_test(integers_are_little_endian),
        cmocka_unit_test(strings_are_length_prefixed),
        cmocka_unit_test(overflowing_the_buffer_is_an_error_not_a_write),
        cmocka_unit_test(tags_wrap_around_the_reserved_notag),
        cmocka_unit_test(names_each_message_the_shim_sends),
        cmocka_unit_test(a_call_without_a_socket_is_enotconn),
    };
    return cmocka_run_group_tests_name("vfs_transport.h", tests, NULL, NULL);
}
