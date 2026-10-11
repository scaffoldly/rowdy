#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int socket_fd(void) {
  DIR *d = opendir("/proc/self/fd");
  struct dirent *e;
  char p[64], l[64];
  int n = -1;
  while (d && (e = readdir(d))) {
    snprintf(p, sizeof p, "/proc/self/fd/%s", e->d_name);
    ssize_t k = readlink(p, l, sizeof l - 1);
    if (k > 0) { l[k] = 0; if (!strncmp(l, "socket:", 7)) n = atoi(e->d_name); }
  }
  if (d) closedir(d);
  return n;
}
static int probe(void) {
  int fd = open("/vfs/sockprobe", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "x", 1) != 1 || close(fd)) return 0;
  FILE *f = fopen("/tmp/ops.log", "r");
  char line[512];
  int flushed = 0;
  while (f && fgets(line, sizeof line, f)) flushed |= strstr(line, "flush /vfs/sockprobe") != NULL;
  if (f) fclose(f);
  unlink("/tmp/ops.log");
  return flushed;
}
int main(void) {
  if (!probe()) { puts("no flush before"); return 1; }
  int n = socket_fd();
  if (n < 256) { printf("socket at fd %d\n", n); return 2; }
  close(n);
  if (!probe()) { printf("lost after close(%d)\n", n); return 3; }
  if (dup2(open("/dev/null", O_WRONLY), n) != n) { printf("dup2 onto %d failed\n", n); return 4; }
  if (!probe()) { printf("lost after dup2 onto %d\n", n); return 5; }
  return 0;
}
