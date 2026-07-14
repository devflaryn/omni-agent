FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install base utilities and reverse engineering tools
RUN apt-get update && apt-get install -y \
    unzip \
    zip \
    wget \
    curl \
    default-jdk \
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

# Create baksmali/smali wrapper scripts using apktool's bundled smali library
# apktool 2.9.3 bundles smali 2.5.x; we expose the main classes as standalone commands.
RUN printf '#!/bin/sh\nexec java -cp /usr/local/bin/apktool.jar com.android.tools.smali.baksmali.Main "$@"\n' > /usr/local/bin/baksmali && \
    chmod +x /usr/local/bin/baksmali && \
    printf '#!/bin/sh\nexec java -cp /usr/local/bin/apktool.jar com.android.tools.smali.smali.Main "$@"\n' > /usr/local/bin/smali && \
    chmod +x /usr/local/bin/smali

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

# NOTE: the Android emulator itself is NOT installed here. It runs natively on
# the Windows host — by default via the bundled qemu-manager.exe (headless
# QEMU/Android-x86), or optionally LDPlayer / Android Studio's emulator.exe —
# not inside this Linux sandbox. See tools/android_emulator.py, which shells
# out directly to the host's adb.exe instead of going through docker exec.

WORKDIR /workspace
