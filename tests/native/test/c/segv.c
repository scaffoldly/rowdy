#include <dirent.h>
#include <pthread.h>
#include <setjmp.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>
static sigjmp_buf jb;
static void recover(int sig) { (void)sig; siglongjmp(jb, 1); }
static int boom(const struct dirent *d) { (void)d; return *(volatile int *)0; }
static int deep(int n) { volatile char pad[1024]; pad[0] = (char)n; return deep(n + 1) + pad[0]; }
static void *overflow(void *a) { (void)a; return (void *)(long)deep(0); }
static void *altstack(void *a) { stack_t ss; sigaltstack(NULL, &ss); *(int *)a = !(ss.ss_flags & SS_DISABLE); return 0; }
static int sleepy(const struct dirent *d) { (void)d; sleep(5); return 0; }
static void *in_hook(void *a) { (void)a; struct dirent **l; scandir("/vfs/faults", &l, sleepy, alphasort); return 0; }
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (!strcmp(argv[1], "null")) return *(volatile int *)0;
  if (!strcmp(argv[1], "thread")) { pthread_t t; pthread_create(&t, 0, overflow, 0); pthread_join(t, 0); }
  if (!strcmp(argv[1], "hook")) { struct dirent **l; return scandir("/vfs/faults", &l, boom, alphasort); }
  if (!strcmp(argv[1], "recover")) { signal(SIGSEGV, recover); if (!sigsetjmp(jb, 1)) return *(volatile int *)0; }
  if (!strcmp(argv[1], "altstack")) { int on = 0; pthread_t t; pthread_create(&t, 0, altstack, &on); pthread_join(t, 0); return on; }
  /* another thread is inside a hook when this one faults */
  if (!strcmp(argv[1], "busy")) { pthread_t t; pthread_create(&t, 0, in_hook, 0); usleep(300000); return *(volatile int *)0; }
  if (!strcmp(argv[1], "ill")) {
#if defined(__x86_64__)
    __asm__ volatile("ud2");
#elif defined(__aarch64__)
    __asm__ volatile(".inst 0x00000000");   /* udf #0 */
#endif
  }
  return 0;
}
