/* stat(2) and lstat(2) as a program calls them through libc: prints the size each reports. */
#include <stdio.h>
#include <sys/stat.h>

int main(int argc, char **argv) {
    struct stat st;
    if (argc != 2) return 2;
    if (stat(argv[1], &st) < 0) { perror("stat"); return 1; }
    printf("stat %lld\n", (long long)st.st_size);
    if (lstat(argv[1], &st) < 0) { perror("lstat"); return 1; }
    printf("lstat %lld\n", (long long)st.st_size);
    return 0;
}
