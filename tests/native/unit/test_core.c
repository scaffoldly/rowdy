/*
 * Unit tests for vfs_core.h: the mount table, path translation in both directions, relative paths
 * resolved against a directory under a mount, and the descriptor table. Run by tests/native/unit.sh.
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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "vfs_fault.h"
#include "vfs_transport.h"
#include "vfs_core.h"

static void mount(const char *prefix, const char *backing) {
    mount_add(prefix, strlen(prefix), backing, strlen(backing));
}

static int unmount_all(void **state) {
    (void)state;
    for (int i = 0; i < g_nmounts; i++) {
        free(g_mounts[i].prefix);
        free(g_mounts[i].backing);
    }
    memset(g_mounts, 0, sizeof g_mounts);
    g_nmounts = 0;
    return 0;
}

static void under_is_a_path_component_boundary(void **state) {
    (void)state;
    assert_true(under("/vfs", "/vfs", 4));
    assert_true(under("/vfs/a", "/vfs", 4));
    assert_false(under("/vfsx", "/vfs", 4));
    assert_false(under("/v", "/vfs", 4));
}

static void the_longest_mount_wins(void **state) {
    (void)state;
    mount("/data", "/tmp/store/data");
    mount("/data/cache", "/tmp/store/cache");
    assert_string_equal(mount_of("/data/x")->prefix, "/data");
    assert_string_equal(mount_of("/data/cache/x")->prefix, "/data/cache");
    assert_string_equal(mount_of("/data/cachex")->prefix, "/data");
    assert_null(mount_of("/other"));
    assert_string_equal(mount_of_backing("/tmp/store/cache/y")->prefix, "/data/cache");
}

static void rel_of_strips_the_mount_and_leading_slashes(void **state) {
    (void)state;
    mount("/vfs", "/tmp/vfsstore");
    const struct vfs_mount *m = mount_of("/vfs");
    assert_string_equal(rel_of(m, "/vfs"), "");
    assert_string_equal(rel_of(m, "/vfs//a/b"), "a/b");
}

static void mount_add_ignores_empty_entries_and_the_seventeenth(void **state) {
    (void)state;
    mount_add("/a", 0, "/b", 2);
    mount_add("/a", 2, "/b", 0);
    assert_int_equal(g_nmounts, 0);
    char prefix[16];
    for (int i = 0; i < MOUNT_MAX + 1; i++) {
        snprintf(prefix, sizeof prefix, "/m%d", i);
        mount(prefix, "/tmp/m");
    }
    assert_int_equal(g_nmounts, MOUNT_MAX);
}

static void xlate_rewrites_into_the_backing_directory(void **state) {
    (void)state;
    mount("/vfs", "/tmp/vfsstore");
    char buf[PATH_MAX];
    assert_string_equal(xlate("/vfs/a/b", buf, sizeof buf), "/tmp/vfsstore/a/b");
    assert_string_equal(xlate("/vfs", buf, sizeof buf), "/tmp/vfsstore");
    const char *other = "/etc/hosts";
    assert_ptr_equal(xlate(other, buf, sizeof buf), other);
    assert_null(xlate(NULL, buf, sizeof buf));
}

static void xlate_leaves_a_path_too_long_for_the_buffer(void **state) {
    (void)state;
    mount("/vfs", "/tmp/vfsstore");
    char small[16];
    const char *path = "/vfs/a/long/enough/path";
    assert_ptr_equal(xlate(path, small, sizeof small), path);
}

static void unxlate_rewrites_back_in_place(void **state) {
    (void)state;
    mount("/vfs", "/tmp/vfsstore");
    char buf[PATH_MAX] = "/tmp/vfsstore/a";
    assert_int_equal(unxlate(buf, sizeof buf), 1);
    assert_string_equal(buf, "/vfs/a");

    char other[PATH_MAX] = "/etc/hosts";
    assert_int_equal(unxlate(other, sizeof other), 0);
    assert_string_equal(other, "/etc/hosts");

    /* a longer prefix than backing that would not fit */
    unmount_all(NULL);
    mount("/a-much-longer-prefix", "/b");
    char tight[8] = "/b/x";
    assert_int_equal(unxlate(tight, sizeof tight), -1);
    assert_string_equal(tight, "/b/x");
}

static void trimmed_drops_trailing_slashes(void **state) {
    (void)state;
    char buf[16];
    assert_string_equal(trimmed("dir/", buf, sizeof buf), "dir");
    assert_string_equal(trimmed("dir///", buf, sizeof buf), "dir");
    const char *plain = "dir";
    assert_ptr_equal(trimmed(plain, buf, sizeof buf), plain);
    assert_string_equal(trimmed("", buf, sizeof buf), "");
}

/* A relative path is resolved against the cwd or a directory descriptor under a mount, folding '.'
 * and '..'. Here the mount's prefix is a real directory, since there is no hooked getcwd. */
static void relative_paths_resolve_against_a_directory_under_a_mount(void **state) {
    (void)state;
    char root[] = "/tmp/vfsunit-XXXXXX";
    assert_non_null(mkdtemp(root));
    char sub[PATH_MAX];
    snprintf(sub, sizeof sub, "%s/a", root);
    assert_int_equal(mkdir(sub, 0700), 0);
    mount(root, "/tmp/vfsunit-backing");

    char cwd[PATH_MAX], out[PATH_MAX], want[PATH_MAX];
    assert_non_null(getcwd(cwd, sizeof cwd));
    assert_int_equal(chdir(sub), 0);
    snprintf(want, sizeof want, "%s/a/c/d", root);
    assert_int_equal(virtual_of_relative(AT_FDCWD, "b/../c/./d", out, sizeof out), 1);
    assert_string_equal(out, want);

    int dirfd = open(sub, O_RDONLY | O_DIRECTORY);
    assert_true(dirfd >= 0);
    snprintf(want, sizeof want, "%s/e", root);
    assert_int_equal(virtual_of_relative(dirfd, "../e", out, sizeof out), 1);
    assert_string_equal(out, want);
    close(dirfd);

    assert_int_equal(virtual_of_relative(AT_FDCWD, "/absolute", out, sizeof out), 0);
    assert_int_equal(virtual_of_relative(-5, "x", out, sizeof out), 0);
    assert_int_equal(chdir(cwd), 0);
    assert_int_equal(virtual_of_relative(AT_FDCWD, "x", out, sizeof out), 0);   /* cwd not under it */

    /* From outside every mount, ".." climbing into one names it: the caller must translate it. */
    char outside[] = "/tmp/vfsunit-out-XXXXXX";
    assert_non_null(mkdtemp(outside));
    assert_int_equal(chdir(outside), 0);
    char climb[PATH_MAX];
    snprintf(climb, sizeof climb, "../%s/a/f", root + strlen("/tmp/"));
    snprintf(want, sizeof want, "%s/a/f", root);
    assert_int_equal(virtual_of_relative(AT_FDCWD, climb, out, sizeof out), 2);
    assert_string_equal(out, want);
    assert_int_equal(virtual_of_relative(AT_FDCWD, "../elsewhere", out, sizeof out), 0);
    assert_int_equal(chdir(cwd), 0);
    rmdir(outside);
    rmdir(sub);
    rmdir(root);
}

static void the_descriptor_table_shares_a_fid_across_dup(void **state) {
    (void)state;
    assert_false(fd_tracked(5));
    fd_track(5, 42);
    assert_true(fd_tracked(5));
    fd_copy(5, 6);
    assert_true(fd_tracked(6));
    assert_int_equal(g_files[6].fid, 42);
    assert_int_equal(*g_files[5].refs, 2);
    assert_ptr_equal(g_files[5].refs, g_files[6].refs);
    assert_false(fd_wlocked(6));
    fd_track(-1, 1);
    fd_track(FD_MAX, 1);
    assert_false(fd_tracked(-1));
    assert_false(fd_tracked(FD_MAX));
    free(g_files[5].refs);
    memset(&g_files[5], 0, sizeof g_files[5]);
    memset(&g_files[6], 0, sizeof g_files[6]);
}

static void untracking_hands_back_the_fid_only_with_its_last_descriptor(void **state) {
    (void)state;
    fd_track(5, 42);
    fd_copy(5, 6);
    assert_int_equal(fd_untrack(5), P9_NOFID);
    assert_false(fd_tracked(5));
    assert_true(fd_tracked(6));
    assert_int_equal(fd_untrack(5), P9_NOFID);   /* a second close of the number */
    assert_int_equal(*g_files[6].refs, 1);
    assert_int_equal(fd_untrack(6), 42);
    assert_false(fd_tracked(6));
    assert_int_equal(fd_untrack(6), P9_NOFID);
    assert_int_equal(fd_untrack(-1), P9_NOFID);
    assert_int_equal(fd_untrack(FD_MAX), P9_NOFID);
    assert_int_equal(fd_release(P9_NOFID), 0);
}

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test_teardown(under_is_a_path_component_boundary, unmount_all),
        cmocka_unit_test_teardown(the_longest_mount_wins, unmount_all),
        cmocka_unit_test_teardown(rel_of_strips_the_mount_and_leading_slashes, unmount_all),
        cmocka_unit_test_teardown(mount_add_ignores_empty_entries_and_the_seventeenth, unmount_all),
        cmocka_unit_test_teardown(xlate_rewrites_into_the_backing_directory, unmount_all),
        cmocka_unit_test_teardown(xlate_leaves_a_path_too_long_for_the_buffer, unmount_all),
        cmocka_unit_test_teardown(unxlate_rewrites_back_in_place, unmount_all),
        cmocka_unit_test_teardown(trimmed_drops_trailing_slashes, unmount_all),
        cmocka_unit_test_teardown(relative_paths_resolve_against_a_directory_under_a_mount, unmount_all),
        cmocka_unit_test_teardown(the_descriptor_table_shares_a_fid_across_dup, unmount_all),
        cmocka_unit_test_teardown(untracking_hands_back_the_fid_only_with_its_last_descriptor, unmount_all),
    };
    return cmocka_run_group_tests_name("vfs_core.h", tests, NULL, NULL);
}
