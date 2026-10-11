# Several mounts at once (VFS_MOUNTS): the longest prefix wins and each maps to its own backing
# directory. The mounts are the child's: bats itself runs with /vfs.

load helpers

setup() {
  export VFS_MOUNTS=/a=/tmp/store/a:/a/inner=/tmp/store/inner:/b=/tmp/store/b
}

teardown() {
  rm -rf /tmp/store
}

@test "each mount reads and writes its own backing directory; a nested mount wins for its subtree" {
  sh -euc '
    echo one > /a/f
    echo two > /b/f
    echo deep > /a/inner/x
    [ "$(cat /a/f)" = "one" ] && [ "$(cat /b/f)" = "two" ]
    [ -f /tmp/store/a/f ] && [ -f /tmp/store/b/f ]
    [ -f /tmp/store/inner/x ] && [ ! -e /tmp/store/a/inner/x ]
  '
}

@test "/vfs is gone when VFS_MOUNTS is set, and a lookalike prefix is not a mount" {
  sh -euc '
    [ ! -e /vfs ]
    [ ! -e /ax ] && [ ! -e /bb ]
  '
}

@test "symlinks, getcwd and mv across mounts, from the shell and from node" {
  sh -euc '
    echo one > /a/f
    echo two > /b/f
    echo deep > /a/inner/x
    ln -s /b/f /a/lnk
    [ "$(readlink /a/lnk)" = "/b/f" ]
    [ "$(cat /a/lnk)" = "two" ]
    [ "$(cd /b && pwd)" = "/b" ]
    [ "$(cd /a/inner && pwd)" = "/a/inner" ]
    mv /a/f /b/g
    [ "$(cat /b/g)" = "one" ] && [ ! -e /a/f ]
  '
  node -e '
const fs = require("fs"), assert = require("assert");
assert.strictEqual(fs.realpathSync("/a/inner/../inner/x"), "/a/inner/x");
assert.deepStrictEqual(fs.readdirSync("/b").sort(), ["f", "g"]);
'
}
