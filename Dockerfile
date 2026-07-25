FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install base utilities and reverse engineering tools
RUN apt-get update && apt-get install -y \
    unzip \
    zip \
    wget \
    curl \
    # Ghidra 11.2+ REQUIRES JDK 21 (Ubuntu 22.04's default-jdk is JDK 17, which
    # makes analyzeHeadless fail to launch — leaving an empty .ghidra_proj and no
    # decompiler output). JDK 21 also runs apktool/baksmali/jadx/apksigner fine,
    # so it's the single JDK for the whole sandbox. See JAVA_HOME below + the
    # Ghidra install step.
    openjdk-21-jdk \
    binutils \
    # LLVM's llvm-objdump gives clean ARM64 disassembly and resolves @plt call
    # targets on stripped .so files — output the host's x86_64 binutils objdump
    # can't produce for aarch64. Used by the llvm_objdump_disasm and
    # analyze_function_calls tools in tools/binary_analysis.py. The package
    # provides an unversioned /usr/bin/llvm-objdump symlink.
    llvm \
    python3 \
    findutils \
    git \
    make \
    gcc \
    zipalign \
    apksigner \
    xxd \
    # Cross assemblers/compilers so the agent can generate real ARM/ARM64 machine
    # code (assemble_and_patch / compile_c_and_patch tools) instead of only
    # patching bytes it already knows. The host gcc/binutils above already cover
    # x86_64/x86 targets since the container itself is x86_64 Linux.
    gcc-aarch64-linux-gnu \
    binutils-aarch64-linux-gnu \
    gcc-arm-linux-gnueabi \
    binutils-arm-linux-gnueabi \
    && rm -rf /var/lib/apt/lists/*

# Install radare2 from source
RUN git clone https://github.com/radareorg/radare2 /opt/radare2 && \
    cd /opt/radare2 && \
    sys/install.sh

# Install apktool for decompiling APKs
RUN wget https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool -O /usr/local/bin/apktool && \
    chmod +x /usr/local/bin/apktool && \
    wget https://github.com/iBotPeaches/Apktool/releases/download/v2.9.3/apktool_2.9.3.jar -O /usr/local/bin/apktool.jar && \
    chmod +x /usr/local/bin/apktool.jar

# Create baksmali/smali wrapper scripts using apktool's bundled smali library.
#
# apktool 2.9.3 bundles smali/baksmali as an internal DEPENDENCY, not a runnable
# CLI: `com.android.tools.smali.baksmali.Main` (and the smali equivalent) is a
# jcommander Command subclass with no main() — `java -cp apktool.jar
# com.android.tools.smali.baksmali.Main ...` fails with "Main method not found
# in class ...". BaksmaliShim/SmaliShim (docker/) call the same library entry
# points apktool itself uses internally (Baksmali.disassembleDexFile,
# brut.androlib.mod.SmaliMod.assembleSmaliFile), so these wrappers actually work.
COPY docker/BaksmaliShim.java docker/SmaliShim.java /usr/local/lib/omni-shims/
RUN cd /usr/local/lib/omni-shims && javac -cp /usr/local/bin/apktool.jar BaksmaliShim.java SmaliShim.java && \
    printf '#!/bin/sh\nset -e\ncase "$1" in d|x|disassemble) shift ;; esac\ndex=""; outdir=""; api=26\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) outdir="$2"; shift 2 ;;\n    -a|--api-level) api="$2"; shift 2 ;;\n    *) dex="$1"; shift ;;\n  esac\ndone\nexec java -cp /usr/local/bin/apktool.jar:/usr/local/lib/omni-shims BaksmaliShim "$dex" "$outdir" "$api"\n' > /usr/local/bin/baksmali && \
    chmod +x /usr/local/bin/baksmali && \
    printf '#!/bin/sh\nset -e\ncase "$1" in a|assemble) shift ;; esac\nsmalidir=""; outdex=""; api=26\nwhile [ $# -gt 0 ]; do\n  case "$1" in\n    -o) outdex="$2"; shift 2 ;;\n    -a|--api-level) api="$2"; shift 2 ;;\n    *) smalidir="$1"; shift ;;\n  esac\ndone\nexec java -cp /usr/local/bin/apktool.jar:/usr/local/lib/omni-shims SmaliShim "$smalidir" "$outdex" "$api"\n' > /usr/local/bin/smali && \
    chmod +x /usr/local/bin/smali

# Install APKEditor — a decode/build tool built on ARSCLib that correctly
# handles APKs with MULTIPLE app-defined resource packages (e.g. Roblox, which
# bundles a personasdk resource package alongside its main one). apktool has a
# long-standing, still-open upstream limitation there (iBotPeaches/Apktool#2514):
# it assumes package 0x7f is the only non-framework package, and aborts full
# resource decoding with "Can't find framework resources for package of id: N"
# on anything else. decode_apk automatically falls back to APKEditor for that
# exact failure signature (see tools/apk_tools.py), which is what lets the
# agent's own patched Roblox builds be decoded/rebuilt with a real (text)
# AndroidManifest.xml instead of only the binary -r fallback.
RUN wget -q https://github.com/REAndroid/APKEditor/releases/download/V1.4.9/APKEditor-1.4.9.jar \
        -O /usr/local/bin/APKEditor.jar && \
    printf '#!/bin/sh\nexec java -jar /usr/local/bin/APKEditor.jar "$@"\n' > /usr/local/bin/apkeditor && \
    chmod +x /usr/local/bin/apkeditor

# Install jadx — the standard Android decompiler that turns DEX bytecode into
# readable Java (far easier to read than smali, especially for obfuscated
# apps), with optional identifier de-obfuscation. Exposed as `jadx` on PATH
# and used by the jadx_decompile tool in tools/apk_tools.py.
RUN JADX_VERSION=1.5.0 && \
    wget -q "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip" \
        -O /tmp/jadx.zip && \
    unzip -q /tmp/jadx.zip -d /opt/jadx && \
    rm /tmp/jadx.zip && \
    ln -s /opt/jadx/bin/jadx /usr/local/bin/jadx

# Ghidra's launch script picks the JVM from JAVA_HOME first; pin it to the JDK 21
# we installed so analyzeHeadless always starts with a supported runtime. The
# openjdk install dir is arch-specific (java-21-openjdk-amd64 on x86_64,
# -arm64 on Apple-Silicon builds), so resolve it from the real `java` binary and
# expose it under a STABLE path — never hardcode the arch suffix.
RUN ln -sfn "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" /opt/java21
ENV JAVA_HOME=/opt/java21
ENV PATH=/opt/java21/bin:$PATH

# Install Ghidra headless analyzer
# Downloads the latest stable release, extracts to /opt/ghidra
RUN GHIDRA_VERSION=11.3.2 && \
    GHIDRA_DATE=20250415 && \
    wget -q "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip" \
        -O /tmp/ghidra.zip && \
    unzip -q /tmp/ghidra.zip -d /opt && \
    mv /opt/ghidra_${GHIDRA_VERSION}_PUBLIC /opt/ghidra && \
    rm /tmp/ghidra.zip && \
    chmod +x /opt/ghidra/support/analyzeHeadless

# Ghidra ships prebuilt DECOMPILER natives only for linux_x86_64 / mac_* / win —
# NOT linux_arm_64. On an Apple-Silicon host this image builds as arm64 Linux, so
# the decompiler is MISSING and every ghidra_decompile fails with
# "os/linux_arm_64/decompile does not exist" (analysis succeeds; only the
# decompiler can't launch). Ghidra bundles the decompiler C++ source, so on arm64
# we build it from source and place it where the analyzer looks. The stock
# Makefile assumes x86 (defaults ARCH_TYPE to -m32); clearing ARCH_TYPE builds a
# native 64-bit aarch64 binary. On x86_64 the shipped native is used and this is a
# no-op. Build takes ~20s. See tools/binary_analysis.py::ghidra_decompile.
RUN ARCH="$(uname -m)"; \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        apt-get update && apt-get install -y --no-install-recommends g++ bison flex && \
        rm -rf /var/lib/apt/lists/* && \
        cd /opt/ghidra/Ghidra/Features/Decompiler/src/decompile/cpp && \
        make ARCH_TYPE= -j"$(nproc)" ghidra_opt && \
        NATIVE_DIR=/opt/ghidra/Ghidra/Features/Decompiler/os/linux_arm_64 && \
        mkdir -p "$NATIVE_DIR" && \
        cp ghidra_opt "$NATIVE_DIR/decompile" && \
        chmod +x "$NATIVE_DIR/decompile" && \
        test -x "$NATIVE_DIR/decompile" && \
        echo "Built linux_arm_64 Ghidra decompiler native."; \
    else \
        echo "x86_64 build — using Ghidra's shipped decompiler native."; \
    fi

# NOTE: the Android emulator itself is NOT installed here. It runs natively on
# the Windows host — by default via the bundled qemu-manager.exe (headless
# QEMU/Android-x86), or optionally LDPlayer / Android Studio's emulator.exe —
# not inside this Linux sandbox. See tools/android_emulator.py, which shells
# out directly to the host's adb.exe instead of going through docker exec.

WORKDIR /workspace
