#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <malloc.h>
#include <windows.h>
#else
#include <time.h>
#endif

#define CACHE_LINE_BYTES 64U
#define WARMUP_ACCESSES 100000U
#define MAX_STRIDES 32U
#define MAX_KB 65536U

static const size_t supported_sizes_kb[] = {
    4, 8, 16, 32, 48, 64, 96, 128, 256, 512, 1024, 2048,
    4096, 8192, 16384, 32768, 65536
};

static uint64_t get_time_ns(void)
{
#ifdef _WIN32
    LARGE_INTEGER counter;
    static LARGE_INTEGER frequency;

    if (frequency.QuadPart == 0 && !QueryPerformanceFrequency(&frequency)) {
        fprintf(stderr, "QueryPerformanceFrequency failed.\n");
        exit(EXIT_FAILURE);
    }
    if (!QueryPerformanceCounter(&counter)) {
        fprintf(stderr, "QueryPerformanceCounter failed.\n");
        exit(EXIT_FAILURE);
    }
    return (uint64_t)(((long double)counter.QuadPart * 1000000000.0L) /
                      (long double)frequency.QuadPart);
#else
    struct timespec now;

    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        fprintf(stderr, "clock_gettime failed: %s\n", strerror(errno));
        exit(EXIT_FAILURE);
    }
    return (uint64_t)now.tv_sec * UINT64_C(1000000000) +
           (uint64_t)now.tv_nsec;
#endif
}

static void *allocate_aligned(size_t size)
{
#ifdef _WIN32
    return _aligned_malloc(size, CACHE_LINE_BYTES);
#else
    void *allocation = NULL;

    if (posix_memalign(&allocation, CACHE_LINE_BYTES, size) != 0) {
        return NULL;
    }
    return allocation;
#endif
}

static void free_aligned(void *allocation)
{
#ifdef _WIN32
    _aligned_free(allocation);
#else
    free(allocation);
#endif
}

static int parse_uint(const char *text, uint64_t minimum, uint64_t maximum,
                      uint64_t *value)
{
    char *end = NULL;
    unsigned long long parsed;

    if (text == NULL || *text == '\0' || *text == '-') {
        return 0;
    }
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' ||
        parsed < minimum || parsed > maximum) {
        return 0;
    }
    *value = (uint64_t)parsed;
    return 1;
}

static uint64_t random_next(uint64_t *state)
{
    uint64_t value = *state;

    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    *state = value;
    return value * UINT64_C(2685821657736338717);
}

static int parse_strides(const char *argument, size_t *strides,
                         size_t *stride_count)
{
    char *copy;
    char *cursor;
    size_t count = 0;

    if (argument == NULL || *argument == '\0') {
        return 0;
    }
    copy = (char *)malloc(strlen(argument) + 1);
    if (copy == NULL) {
        fprintf(stderr, "Could not allocate memory to parse strides.\n");
        return -1;
    }
    strcpy(copy, argument);
    cursor = copy;
    while (*cursor != '\0') {
        char *token = cursor;
        char *separator = strchr(cursor, ',');
        uint64_t stride;
        size_t i;

        if (separator != NULL) {
            *separator = '\0';
            cursor = separator + 1;
            if (*cursor == '\0') {
                free(copy);
                return 0;
            }
        } else {
            cursor += strlen(cursor);
        }
        if (count == MAX_STRIDES ||
            !parse_uint(token, sizeof(uint32_t), 1048576U, &stride) ||
            stride % sizeof(uint32_t) != 0) {
            free(copy);
            return 0;
        }
        for (i = 0; i < count; ++i) {
            if (strides[i] == (size_t)stride) {
                free(copy);
                return 0;
            }
        }
        strides[count++] = (size_t)stride;
    }
    free(copy);
    if (count == 0) {
        return 0;
    }
    *stride_count = count;
    return 1;
}

static int build_cycle(uint32_t *memory, uint32_t *order, size_t count,
                       size_t words_per_stride, uint64_t seed)
{
    size_t i;
    size_t zero_position = 0;

    if (count == 0 || count > UINT32_MAX) {
        return 0;
    }
    if (seed == 0) {
        seed = UINT64_C(0x9e3779b97f4a7c15);
    }
    for (i = 0; i < count; ++i) {
        order[i] = (uint32_t)i;
    }
    for (i = count - 1; i > 0; --i) {
        size_t selected = (size_t)(random_next(&seed) % (i + 1));
        uint32_t temporary = order[i];

        order[i] = order[selected];
        order[selected] = temporary;
    }
    for (i = 0; i < count; ++i) {
        if (order[i] == 0) {
            zero_position = i;
            break;
        }
    }
    {
        uint32_t temporary = order[0];
        order[0] = order[zero_position];
        order[zero_position] = temporary;
    }
    for (i = 0; i + 1 < count; ++i) {
        memory[(size_t)order[i] * words_per_stride] = order[i + 1];
    }
    memory[(size_t)order[count - 1] * words_per_stride] = 0;
    return 1;
}

static uint64_t traverse(uint32_t *memory, uint32_t start,
                         size_t words_per_stride, size_t accesses)
{
    size_t completed = 0;
    uint32_t index = start;
    volatile uint32_t curr = 0;

#define CHASE_ONE() (index = memory[(size_t)index * words_per_stride])
#define CHASE_SIXTEEN() \
    CHASE_ONE(); CHASE_ONE(); CHASE_ONE(); CHASE_ONE(); \
    CHASE_ONE(); CHASE_ONE(); CHASE_ONE(); CHASE_ONE(); \
    CHASE_ONE(); CHASE_ONE(); CHASE_ONE(); CHASE_ONE(); \
    CHASE_ONE(); CHASE_ONE(); CHASE_ONE(); CHASE_ONE()

    while (completed + 16 <= accesses) {
        CHASE_SIXTEEN();
        completed += 16;
    }
    while (completed < accesses) {
        CHASE_ONE();
        ++completed;
    }
    curr = index;
#undef CHASE_SIXTEEN
#undef CHASE_ONE
    return curr;
}

static int measure(size_t size_kb, size_t stride_bytes, size_t iterations)
{
    const size_t bytes = size_kb * 1024U;
    const size_t count = bytes / stride_bytes;
    const size_t words_per_stride = stride_bytes / sizeof(uint32_t);
    uint32_t *memory;
    uint32_t *order;
    uint64_t start_time;
    uint64_t end_time;
    uint64_t sink;
    double latency_ns;

    if (bytes % stride_bytes != 0 || count == 0 || count > UINT32_MAX ||
        count > SIZE_MAX / sizeof(uint32_t) ||
        (count - 1) * words_per_stride >= bytes / sizeof(uint32_t)) {
        fprintf(stderr, "Skipping invalid configuration: %zu KB, %zu B.\n",
                size_kb, stride_bytes);
        return 0;
    }

    memory = (uint32_t *)allocate_aligned(bytes);
    order = (uint32_t *)malloc(count * sizeof(*order));
    if (memory == NULL || order == NULL) {
        fprintf(stderr,
                "Warning: allocation failed for %zu KB, %zu B; skipping.\n",
                size_kb, stride_bytes);
        free_aligned(memory);
        free(order);
        return 0;
    }
    if (!build_cycle(memory, order, count, words_per_stride,
                     get_time_ns() ^ (uint64_t)bytes ^
                         ((uint64_t)stride_bytes << 32))) {
        fprintf(stderr, "Could not build pointer cycle; skipping.\n");
        free_aligned(memory);
        free(order);
        return 0;
    }

    (void)traverse(memory, order[0], words_per_stride, WARMUP_ACCESSES);
    start_time = get_time_ns();
    sink = traverse(memory, order[0], words_per_stride, iterations);
    end_time = get_time_ns();
    free(order);

    if (end_time <= start_time) {
        fprintf(stderr, "Timer did not advance; skipping configuration.\n");
        free_aligned(memory);
        return 0;
    }
    latency_ns = (double)(end_time - start_time) / (double)iterations;
    if (printf("{\"size_kb\": %zu, \"stride_bytes\": %zu, "
               "\"latency_ns\": %.4f}\n",
               size_kb, stride_bytes, latency_ns) < 0 ||
        fflush(stdout) != 0) {
        fprintf(stderr, "Failed to write measurement to stdout.\n");
        free_aligned(memory);
        return -1;
    }
    (void)sink;
    free_aligned(memory);
    return 1;
}

static void print_usage(const char *program)
{
    fprintf(stderr,
            "Usage: %s [min_kb max_kb stride1,stride2,... iterations]\n"
            "Defaults: 4 65536 16,64,256,4096 5000000\n"
            "Sizes must be 4..65536 KB; strides must be unique, "
            "positive multiples of 4 bytes.\n",
            program);
}

int main(int argc, char **argv)
{
    uint64_t min_kb = 4;
    uint64_t max_kb = MAX_KB;
    uint64_t iterations = 5000000;
    size_t strides[MAX_STRIDES] = {16, 64, 256, 4096};
    size_t stride_count = 4;
    size_t size_count =
        sizeof(supported_sizes_kb) / sizeof(supported_sizes_kb[0]);
    size_t size_index;
    size_t stride_index;

    if (argc != 1 && argc != 5) {
        print_usage(argv[0]);
        return EXIT_FAILURE;
    }
    if (argc == 5) {
        int stride_result;

        if (!parse_uint(argv[1], 4, MAX_KB, &min_kb) ||
            !parse_uint(argv[2], 4, MAX_KB, &max_kb) ||
            min_kb > max_kb ||
            !parse_uint(argv[4], 1, UINT64_C(100000000), &iterations)) {
            print_usage(argv[0]);
            return EXIT_FAILURE;
        }
        stride_result = parse_strides(argv[3], strides, &stride_count);
        if (stride_result != 1) {
            if (stride_result == 0) {
                fprintf(stderr, "Invalid stride list: %s\n", argv[3]);
            }
            print_usage(argv[0]);
            return EXIT_FAILURE;
        }
    }

    for (size_index = 0; size_index < size_count; ++size_index) {
        size_t size_kb = supported_sizes_kb[size_index];

        if (size_kb < min_kb || size_kb > max_kb) {
            continue;
        }
        for (stride_index = 0; stride_index < stride_count; ++stride_index) {
            if (measure(size_kb, strides[stride_index],
                        (size_t)iterations) < 0) {
                return EXIT_FAILURE;
            }
        }
    }
    return EXIT_SUCCESS;
}
