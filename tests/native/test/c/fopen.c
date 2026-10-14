#include <stdio.h>
#include <string.h>
int main(void) {
  FILE *f = fopen("/vfs/f.txt", "w"); if (!f) return 1;
  fputs("fopen", f); fclose(f);
  char b[16] = {0}; f = fopen("/vfs/f.txt", "r"); if (!f) return 2;
  fgets(b, sizeof b, f); fclose(f);
  if (strcmp(b, "fopen")) return 3;
  if (remove("/vfs/f.txt")) return 4;
  return 0;
}
