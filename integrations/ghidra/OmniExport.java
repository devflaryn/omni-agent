// Omni knowledge-graph export: one JSON object per line for Omni's kgraph importer (server/kgraph-import.mjs).
//   {"t":"bin", ...}   the program          {"t":"fn", name, addr, size, thunk, ext}   every function
//   {"t":"call", from, to}                   {"t":"str", addr, value, refs:[function entry addrs]}
//   {"t":"imp", name, lib, addr}             {"t":"exp", name, addr}
// Usage (headless): analyzeHeadless <projDir> <projName> -import <bin> -postScript OmniExport.java <out.jsonl>
//@category Omni
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class OmniExport extends GhidraScript {
    private Writer out;

    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        return b.toString();
    }

    private static String addr(Address a) { return "0x" + Long.toHexString(a.getOffset()); }

    private void line(String json) throws IOException { out.write(json); out.write('\n'); }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        String path = args.length > 0 ? args[0] : currentProgram.getName() + ".jsonl";
        out = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(path), StandardCharsets.UTF_8), 1 << 20);
        try {
            line(String.format("{\"t\":\"bin\",\"name\":\"%s\",\"format\":\"%s\",\"arch\":\"%s\",\"path\":\"%s\"}",
                esc(currentProgram.getName()), esc(currentProgram.getExecutableFormat()), esc(currentProgram.getLanguageID().toString()), esc(currentProgram.getExecutablePath())));
            FunctionManager fm = currentProgram.getFunctionManager();
            int fns = 0, calls = 0, strs = 0;
            for (Function f : fm.getFunctions(true)) {
                if (monitor.isCancelled()) break;
                line(String.format("{\"t\":\"fn\",\"name\":\"%s\",\"addr\":\"%s\",\"size\":%d,\"thunk\":%b,\"ext\":%b}",
                    esc(f.getName(true)), addr(f.getEntryPoint()), f.getBody().getNumAddresses(), f.isThunk(), f.isExternal()));
                fns++;
                for (Function c : f.getCalledFunctions(monitor)) {
                    line(String.format("{\"t\":\"call\",\"from\":\"%s\",\"to\":\"%s\"}", addr(f.getEntryPoint()), addr(c.getEntryPoint())));
                    calls++;
                }
            }
            ReferenceManager rm = currentProgram.getReferenceManager();
            for (Data d : currentProgram.getListing().getDefinedData(true)) {
                if (!d.hasStringValue()) continue;
                if (monitor.isCancelled()) break;
                Object v = d.getValue();
                if (v == null) continue;
                Set<String> refs = new LinkedHashSet<>();
                for (Reference r : rm.getReferencesTo(d.getAddress())) {
                    Function f = fm.getFunctionContaining(r.getFromAddress());
                    if (f != null) refs.add("\"" + addr(f.getEntryPoint()) + "\"");
                    if (refs.size() >= 50) break;
                }
                String s = v.toString();
                if (s.length() > 300) s = s.substring(0, 300);
                line(String.format("{\"t\":\"str\",\"addr\":\"%s\",\"value\":\"%s\",\"refs\":[%s]}", addr(d.getAddress()), esc(s), String.join(",", refs)));
                strs++;
            }
            SymbolTable st = currentProgram.getSymbolTable();
            for (Symbol s : st.getExternalSymbols()) {
                ExternalLocation loc = currentProgram.getExternalManager().getExternalLocation(s);
                String lib = loc != null ? loc.getLibraryName() : "";
                line(String.format("{\"t\":\"imp\",\"name\":\"%s\",\"lib\":\"%s\",\"addr\":\"\"}", esc(s.getName()), esc(lib)));
            }
            for (Address a : st.getExternalEntryPointIterator()) {
                Symbol s = st.getPrimarySymbol(a);
                if (s != null) line(String.format("{\"t\":\"exp\",\"name\":\"%s\",\"addr\":\"%s\"}", esc(s.getName()), addr(a)));
            }
            println(String.format("OmniExport: %d functions, %d calls, %d strings -> %s", fns, calls, strs, path));
        } finally {
            out.close();
        }
    }
}
