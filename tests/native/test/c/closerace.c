/* Threads opening, reading and closing virtual files at once, as libuv's pool does for parallel
 * fs.readFile: the kernel hands a just-closed descriptor number straight to the next open. */
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define FILES 5
#define THREADS 8

static int iterations;

static void *reader(void *arg) {
  long id = (long)arg;
  char path[32], b[64];
  for (int i = 0; i < iterations; i++) {
    snprintf(path, sizeof path, "/vfs/race/%ld.json", (id + i) % FILES);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { perror(path); exit(2); }
    if (read(fd, b, sizeof b) <= 0) { perror("read"); exit(3); }
    if (close(fd) != 0) { perror("close"); exit(4); }
  }
  return NULL;
}

int main(int argc, char **argv) {
  iterations = argc > 1 ? atoi(argv[1]) : 2000;
  pthread_t t[THREADS];
  for (long i = 0; i < THREADS; i++) pthread_create(&t[i], NULL, reader, (void *)i);
  for (int i = 0; i < THREADS; i++) pthread_join(t[i], NULL);
  return 0;
}
