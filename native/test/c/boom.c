__attribute__((constructor)) static void boom(void) { *(volatile int *)0 = 1; }
