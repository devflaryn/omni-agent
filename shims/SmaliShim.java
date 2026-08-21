// Standalone smali -> dex assembler, driven directly against apktool's own
// SmaliMod helper (the same code path apktool's `b`/build command uses).
//
// Why this exists: apktool 2.9.3 bundles smali/baksmali as an internal
// dependency, not a runnable CLI — see BaksmaliShim.java for the disassembly
// side of this same problem. This shim walks a directory of .smali files,
// assembles each into a shared DexBuilder, then writes it out as one .dex —
// so `smali a/assemble <dir> -o <out.dex>` works as a standalone command
// again (used by tools/dex_editing.py).
import brut.androlib.mod.SmaliMod;
import com.android.tools.smali.dexlib2.Opcodes;
import com.android.tools.smali.dexlib2.writer.builder.DexBuilder;
import com.android.tools.smali.dexlib2.writer.io.FileDataStore;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

public class SmaliShim {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: SmaliShim <smali-dir> <output-dex> [apiLevel]");
            System.exit(2);
        }
        File smaliDir = new File(args[0]);
        File outputDex = new File(args[1]);
        int apiLevel = args.length > 2 ? Integer.parseInt(args[2]) : 26;

        List<File> smaliFiles = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(smaliDir.toPath())) {
            walk.filter(p -> p.toString().endsWith(".smali"))
                .forEach(p -> smaliFiles.add(p.toFile()));
        }
        if (smaliFiles.isEmpty()) {
            System.err.println("no .smali files found under " + smaliDir);
            System.exit(1);
        }

        DexBuilder dexBuilder = new DexBuilder(Opcodes.forApi(apiLevel));
        boolean allOk = true;
        for (File f : smaliFiles) {
            boolean ok = SmaliMod.assembleSmaliFile(f, dexBuilder, apiLevel, false, false);
            if (!ok) {
                System.err.println("failed to assemble: " + f);
                allOk = false;
            }
        }
        if (!allOk) {
            System.exit(1);
        }
        if (outputDex.exists()) {
            outputDex.delete();
        }
        FileDataStore out = new FileDataStore(outputDex);
        try {
            dexBuilder.writeTo(out);
        } finally {
            out.close();
        }
        System.out.println("OK: assembled " + smaliFiles.size() + " smali file(s) into " + outputDex);
    }
}
