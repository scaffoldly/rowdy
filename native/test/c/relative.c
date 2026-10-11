#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
int main(void) {
  if (mkdir("/vfs/rel", 0755)) return 1;
  int d = open("/vfs/rel", O_RDONLY | O_DIRECTORY);
  if (d < 0) return 2;
  int fd = openat(d, "made.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "x", 1) != 1 || close(fd)) return 3;
  if (mkdirat(d, "sub", 0755)) return 4;
  if (renameat(d, "made.txt", d, "sub/moved.txt")) return 5;
  struct stat st;
  if (fstatat(d, "sub/moved.txt", &st, 0)) return 6;
  if (unlinkat(d, "sub/moved.txt", 0) || unlinkat(d, "sub", AT_REMOVEDIR)) return 7;
  if (chdir("/vfs/rel")) return 8;
  fd = open("cwd.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "y", 1) != 1 || close(fd)) return 9;
  if (mkdir("cwdsub", 0755) || rename("cwd.txt", "cwdsub/cwd2.txt")) return 10;
  if (unlink("cwdsub/cwd2.txt") || rmdir("cwdsub") || chdir("/")) return 11;
  close(d);
  return rmdir("/vfs/rel") ? 12 : 0;
}
