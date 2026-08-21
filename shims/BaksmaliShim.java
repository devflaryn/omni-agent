// Standalone dex -> smali disassembler, driven directly against the smali
// library classes bundled in apktool.jar.
//
// Why this exists: apktool 2.9.3 bundles smali/baksmali as an internal
// dependency, not a runnable CLI. `com.android.tools.smali.baksmali.Main` is a
// jcommander Command subclass with no main() — invoking it directly fails with
// "Main method not found in class ...". This shim calls the real library
// entry point (Baksmali.disassembleDexFile) that apktool itself uses
// internally, so `baksmali d/disassemble <dex> -o <dir>` works as a standalone
// command again (used by tools/session_bootstrap.py and tools/dex_editing.py).
import com.android.tools.smali.baksmali.Baksmali;
import com.android.tools.smali.baksmali.BaksmaliOptions;
import com.android.tools.smali.dexlib2.DexFileFactory;
import com.android.tools.smali.dexlib2.Opcodes;
import com.android.tools.smali.dexlib2.iface.DexFile;
import com.android.tools.smali.dexlib2.iface.MultiDexContainer;

import java.io.File;
import java.util.List;

public class BaksmaliShim {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: BaksmaliShim <dex-or-apk> <output-dir> [apiLevel]");
            System.exit(2);
        }
        File input = new File(args[0]);
        File outDir = new File(args[1]);
        int apiLevel = args.length > 2 ? Integer.parseInt(args[2]) : 26;
        Opcodes opcodes = Opcodes.forApi(apiLevel);

        MultiDexContainer<? extends DexFile> container = DexFileFactory.loadDexContainer(input, opcodes);
        List<String> entryNames = container.getDexEntryNames();
        BaksmaliOptions options = new BaksmaliOptions();
        options.apiLevel = apiLevel;
        options.parameterRegisters = true;
        options.localsDirective = true;
        options.sequentialLabels = true;
        options.debugInfo = true;
        options.codeOffsets = false;
        options.accessorComments = true;
        options.implicitReferences = false;
        options.normalizeVirtualMethods = false;

        for (String name : entryNames) {
            DexFile dex = container.getEntry(name).getDexFile();
            boolean ok = Baksmali.disassembleDexFile(dex, outDir, 4, options);
            if (!ok) {
                System.err.println("disassembly reported failure for entry: " + name);
                System.exit(1);
            }
        }
        System.out.println("OK: disassembled " + entryNames.size() + " dex entr" +
                (entryNames.size() == 1 ? "y" : "ies") + " into " + outDir);
    }
}
