/**
 * Java judge driver generation.
 *
 * Unlike the C++ side, Java generics erase at runtime, so overload resolution on
 * `List<Integer>` vs `List<String>` is impossible. Instead:
 *   - deserialization uses explicitly-named typed helpers chosen from metaData
 *   - serialization is one reflective `ser(Object)` that inspects the value at runtime
 *
 * The whole thing is emitted as a single Main.java, because `javac Main.java` with
 * one file keeps the backend runner trivial.
 */

import { SENTINEL, isSystemDesign } from './harness.mjs';

const PRELUDE = `import java.util.*;
import java.util.function.*;
import java.io.*;
import java.lang.reflect.Array;

class ListNode {
  int val; ListNode next;
  ListNode() {}
  ListNode(int val) { this.val = val; }
  ListNode(int val, ListNode next) { this.val = val; this.next = next; }
}

class TreeNode {
  int val; TreeNode left; TreeNode right;
  TreeNode() {}
  TreeNode(int val) { this.val = val; }
  TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; }
}

final class J {
  static final int NUL = 0, BOOL = 1, NUM = 2, STR = 3, ARR = 4;
  int t = NUL;
  boolean b;
  double n;
  String s;
  List<J> a = new ArrayList<>();
  Map<String, J> o = new LinkedHashMap<>();

  boolean isNull() { return t == NUL; }
  J at(int i) { return i >= 0 && i < a.size() ? a.get(i) : new J(); }
  J key(String k) { J v = o.get(k); return v == null ? new J() : v; }

  // ---- parser
  private static String src;
  private static int p;

  static J parse(String text) { src = text; p = 0; ws(); return value(); }

  private static void ws() {
    while (p < src.length() && Character.isWhitespace(src.charAt(p))) p++;
  }

  private static J value() {
    ws();
    if (p >= src.length()) return new J();
    char c = src.charAt(p);
    if (c == '{') return obj();
    if (c == '[') return arr();
    if (c == '"') { J j = new J(); j.t = STR; j.s = str(); return j; }
    if (c == 't') { p += 4; J j = new J(); j.t = BOOL; j.b = true; return j; }
    if (c == 'f') { p += 5; J j = new J(); j.t = BOOL; j.b = false; return j; }
    if (c == 'n') { p += 4; return new J(); }
    return num();
  }

  private static J obj() {
    J j = new J(); j.t = ARR; p++; ws();
    if (p < src.length() && src.charAt(p) == '}') { p++; return j; }
    while (p < src.length()) {
      ws(); String k = str(); ws();
      if (p < src.length() && src.charAt(p) == ':') p++;
      j.o.put(k, value()); ws();
      if (p < src.length() && src.charAt(p) == ',') { p++; continue; }
      if (p < src.length() && src.charAt(p) == '}') { p++; break; }
      break;
    }
    return j;
  }

  private static J arr() {
    J j = new J(); j.t = ARR; p++; ws();
    if (p < src.length() && src.charAt(p) == ']') { p++; return j; }
    while (p < src.length()) {
      j.a.add(value()); ws();
      if (p < src.length() && src.charAt(p) == ',') { p++; continue; }
      if (p < src.length() && src.charAt(p) == ']') { p++; break; }
      break;
    }
    return j;
  }

  private static String str() {
    StringBuilder sb = new StringBuilder();
    if (p < src.length() && src.charAt(p) == '"') p++;
    while (p < src.length() && src.charAt(p) != '"') {
      char c = src.charAt(p);
      if (c == '\\\\' && p + 1 < src.length()) {
        p++;
        char e = src.charAt(p++);
        switch (e) {
          case 'n': sb.append('\\n'); break;
          case 't': sb.append('\\t'); break;
          case 'r': sb.append('\\r'); break;
          case 'b': sb.append('\\b'); break;
          case 'f': sb.append('\\f'); break;
          case 'u': sb.append((char) Integer.parseInt(src.substring(p, p + 4), 16)); p += 4; break;
          default: sb.append(e);
        }
      } else { sb.append(c); p++; }
    }
    if (p < src.length() && src.charAt(p) == '"') p++;
    return sb.toString();
  }

  private static J num() {
    int start = p;
    while (p < src.length()) {
      char c = src.charAt(p);
      if (Character.isDigit(c) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') p++;
      else break;
    }
    J j = new J(); j.t = NUM;
    j.n = Double.parseDouble(src.substring(start, p));
    return j;
  }
}

final class H {
  // ---- deserialize (typed, chosen by codegen)
  static int asInt(J j) { return (int) j.n; }
  static long asLong(J j) { return (long) j.n; }
  static double asDouble(J j) { return j.n; }
  static boolean asBool(J j) { return j.t == J.BOOL ? j.b : j.n != 0; }
  static String asStr(J j) { return j.s == null ? "" : j.s; }
  static char asChar(J j) { return j.s == null || j.s.isEmpty() ? '\\0' : j.s.charAt(0); }

  static int[] asIntArr(J j) {
    int[] r = new int[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = (int) j.a.get(i).n;
    return r;
  }

  static long[] asLongArr(J j) {
    long[] r = new long[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = (long) j.a.get(i).n;
    return r;
  }

  static double[] asDoubleArr(J j) {
    double[] r = new double[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = j.a.get(i).n;
    return r;
  }

  static boolean[] asBoolArr(J j) {
    boolean[] r = new boolean[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = asBool(j.a.get(i));
    return r;
  }

  static String[] asStrArr(J j) {
    String[] r = new String[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = asStr(j.a.get(i));
    return r;
  }

  static char[] asCharArr(J j) {
    char[] r = new char[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = asChar(j.a.get(i));
    return r;
  }

  static int[][] asIntArr2(J j) {
    int[][] r = new int[j.a.size()][];
    for (int i = 0; i < r.length; i++) r[i] = asIntArr(j.a.get(i));
    return r;
  }

  static char[][] asCharArr2(J j) {
    char[][] r = new char[j.a.size()][];
    for (int i = 0; i < r.length; i++) r[i] = asCharArr(j.a.get(i));
    return r;
  }

  static String[][] asStrArr2(J j) {
    String[][] r = new String[j.a.size()][];
    for (int i = 0; i < r.length; i++) r[i] = asStrArr(j.a.get(i));
    return r;
  }

  static List<Integer> asIntList(J j) {
    List<Integer> r = new ArrayList<>();
    for (J e : j.a) r.add((int) e.n);
    return r;
  }

  static List<String> asStrList(J j) {
    List<String> r = new ArrayList<>();
    for (J e : j.a) r.add(asStr(e));
    return r;
  }

  static List<List<Integer>> asIntList2(J j) {
    List<List<Integer>> r = new ArrayList<>();
    for (J e : j.a) r.add(asIntList(e));
    return r;
  }

  static List<List<String>> asStrList2(J j) {
    List<List<String>> r = new ArrayList<>();
    for (J e : j.a) r.add(asStrList(e));
    return r;
  }

  static ListNode asList(J j) {
    ListNode head = null, tail = null;
    for (J e : j.a) {
      ListNode node = new ListNode((int) e.n);
      if (head == null) { head = tail = node; } else { tail.next = node; tail = node; }
    }
    return head;
  }

  static ListNode[] asListArr(J j) {
    ListNode[] r = new ListNode[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = asList(j.a.get(i));
    return r;
  }

  static TreeNode asTree(J j) {
    if (j.a.isEmpty() || j.a.get(0).isNull()) return null;
    TreeNode root = new TreeNode((int) j.a.get(0).n);
    Deque<TreeNode> q = new ArrayDeque<>();
    q.add(root);
    int i = 1;
    while (!q.isEmpty() && i < j.a.size()) {
      TreeNode cur = q.poll();
      if (i < j.a.size()) { J L = j.a.get(i++); if (!L.isNull()) { cur.left = new TreeNode((int) L.n); q.add(cur.left); } }
      if (i < j.a.size()) { J R = j.a.get(i++); if (!R.isNull()) { cur.right = new TreeNode((int) R.n); q.add(cur.right); } }
    }
    return root;
  }

  static TreeNode[] asTreeArr(J j) {
    TreeNode[] r = new TreeNode[j.a.size()];
    for (int i = 0; i < r.length; i++) r[i] = asTree(j.a.get(i));
    return r;
  }

  // List<...> variants for metaData in list<> form (older problems).
  static List<ListNode> asListList(J j) {
    List<ListNode> r = new ArrayList<>();
    for (J e : j.a) r.add(asList(e));
    return r;
  }

  static List<TreeNode> asTreeList(J j) {
    List<TreeNode> r = new ArrayList<>();
    for (J e : j.a) r.add(asTree(e));
    return r;
  }

  static List<Boolean> asBoolList(J j) {
    List<Boolean> r = new ArrayList<>();
    for (J e : j.a) r.add(asBool(e));
    return r;
  }

  static List<Long> asLongList(J j) {
    List<Long> r = new ArrayList<>();
    for (J e : j.a) r.add((long) e.n);
    return r;
  }

  static List<Double> asDoubleList(J j) {
    List<Double> r = new ArrayList<>();
    for (J e : j.a) r.add(e.n);
    return r;
  }

  static List<Character> asCharList(J j) {
    List<Character> r = new ArrayList<>();
    for (J e : j.a) r.add(asChar(e));
    return r;
  }

  // ---- serialize (reflective: generics are erased, so inspect at runtime)
  static String esc(String s) {
    StringBuilder o = new StringBuilder("\\"");
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"': o.append("\\\\\\""); break;
        case '\\\\': o.append("\\\\\\\\"); break;
        case '\\n': o.append("\\\\n"); break;
        case '\\t': o.append("\\\\t"); break;
        case '\\r': o.append("\\\\r"); break;
        default:
          if (c < 0x20) o.append(String.format("\\\\u%04x", (int) c));
          else o.append(c);
      }
    }
    return o.append('"').toString();
  }

  static String numStr(double d) {
    if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 9e15) return String.valueOf((long) d);
    return String.valueOf(d);
  }

  static String ser(Object v) {
    if (v == null) return "null";
    if (v instanceof String) return esc((String) v);
    if (v instanceof Character) return esc(String.valueOf(v));
    if (v instanceof Boolean) return v.toString();
    if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) return v.toString();
    if (v instanceof Double || v instanceof Float) return numStr(((Number) v).doubleValue());

    if (v instanceof ListNode) {
      StringBuilder sb = new StringBuilder("[");
      ListNode n = (ListNode) v;
      int guard = 0;
      boolean first = true;
      while (n != null && guard++ < 100000) {
        if (!first) sb.append(',');
        sb.append(n.val);
        first = false;
        n = n.next;
      }
      return sb.append(']').toString();
    }

    if (v instanceof TreeNode) {
      List<String> out = new ArrayList<>();
      Deque<TreeNode> q = new ArrayDeque<>();
      q.add((TreeNode) v);
      while (!q.isEmpty()) {
        TreeNode c = q.poll();
        if (c == null) { out.add("null"); continue; }
        out.add(String.valueOf(c.val));
        q.add(c.left);
        q.add(c.right);
      }
      while (!out.isEmpty() && out.get(out.size() - 1).equals("null")) out.remove(out.size() - 1);
      return "[" + String.join(",", out) + "]";
    }

    if (v.getClass().isArray()) {
      int len = Array.getLength(v);
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < len; i++) {
        if (i > 0) sb.append(',');
        sb.append(ser(Array.get(v, i)));
      }
      return sb.append(']').toString();
    }

    if (v instanceof Collection) {
      StringBuilder sb = new StringBuilder("[");
      boolean first = true;
      for (Object e : (Collection<?>) v) {
        if (!first) sb.append(',');
        sb.append(ser(e));
        first = false;
      }
      return sb.append(']').toString();
    }

    if (v instanceof Map) {
      StringBuilder sb = new StringBuilder("{");
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
        if (!first) sb.append(',');
        sb.append(esc(String.valueOf(e.getKey()))).append(':').append(ser(e.getValue()));
        first = false;
      }
      return sb.append('}').toString();
    }

    return esc(String.valueOf(v));
  }

  static void emit(int i, boolean ok, String out, double ms, String err, String log) {
    System.out.println("${SENTINEL}{\\"i\\":" + i
      + ",\\"ok\\":" + ok
      + ",\\"out\\":" + (out == null || out.isEmpty() ? "null" : out)
      + ",\\"ms\\":" + numStr(ms)
      + ",\\"err\\":" + esc(err == null ? "" : err)
      + ",\\"log\\":" + esc(log == null ? "" : log)
      + "}");
    System.out.flush();
  }

  static String trace(Throwable t) {
    StringWriter sw = new StringWriter();
    t.printStackTrace(new PrintWriter(sw));
    String s = sw.toString();
    return s.length() > 3000 ? s.substring(0, 3000) : s;
  }

  static String readAll() throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    int n;
    while ((n = System.in.read(chunk)) > 0) buf.write(chunk, 0, n);
    return buf.toString("UTF-8");
  }
}
`;

const DESERIALIZE = {
  integer: 'asInt',
  int: 'asInt',
  long: 'asLong',
  double: 'asDouble',
  float: 'asDouble',
  boolean: 'asBool',
  string: 'asStr',
  String: 'asStr',
  character: 'asChar',
  char: 'asChar',
  ListNode: 'asList',
  TreeNode: 'asTree',
  'integer[]': 'asIntArr',
  'int[]': 'asIntArr',
  'long[]': 'asLongArr',
  'double[]': 'asDoubleArr',
  'boolean[]': 'asBoolArr',
  'string[]': 'asStrArr',
  'String[]': 'asStrArr',
  'character[]': 'asCharArr',
  'char[]': 'asCharArr',
  'integer[][]': 'asIntArr2',
  'int[][]': 'asIntArr2',
  'character[][]': 'asCharArr2',
  'char[][]': 'asCharArr2',
  'string[][]': 'asStrArr2',
  'String[][]': 'asStrArr2',
  'ListNode[]': 'asListArr',
  'TreeNode[]': 'asTreeArr',
  'list<integer>': 'asIntList',
  'list<string>': 'asStrList',
  'list<String>': 'asStrList',
  'list<list<integer>>': 'asIntList2',
  'list<list<string>>': 'asStrList2',
  'list<list<String>>': 'asStrList2',
  'list<ListNode>': 'asListList',
  'list<TreeNode>': 'asTreeList',
  'list<boolean>': 'asBoolList',
  'list<long>': 'asLongList',
  'list<double>': 'asDoubleList',
  'list<character>': 'asCharList',
  'list<char>': 'asCharList',
};

const JAVA_TYPE = {
  integer: 'int',
  int: 'int',
  long: 'long',
  double: 'double',
  float: 'double',
  boolean: 'boolean',
  string: 'String',
  String: 'String',
  character: 'char',
  char: 'char',
  void: 'void',
  ListNode: 'ListNode',
  TreeNode: 'TreeNode',
};

/** Exported for the test suite and the app's diagnostics. */
export function javaType(raw) {
  if (!raw) return 'void';
  const t = String(raw).trim();

  const list = t.match(/^list<(.+)>$/i);
  if (list) {
    const inner = javaType(list[1]);
    const boxed = { int: 'Integer', long: 'Long', double: 'Double', boolean: 'Boolean', char: 'Character' }[inner] || inner;
    return `List<${boxed}>`;
  }
  if (t.endsWith('[]')) return `${javaType(t.slice(0, -2))}[]`;
  return JAVA_TYPE[t] || JAVA_TYPE[t.toLowerCase()] || 'int';
}

/** Exported for the test suite: the deserializer helper for a metaData type. */
export function helperFor(rawType) {
  const t = String(rawType || '').trim();
  return DESERIALIZE[t] || DESERIALIZE[t.toLowerCase()] || 'asInt';
}

function buildFunction(meta) {
  const params = meta.params || [];
  const decls = params.map((p, i) =>
    `      ${javaType(p.type)} a${i} = H.${helperFor(p.type)}(in.at(${i}));`
  ).join('\n');
  const args = params.map((_, i) => `a${i}`).join(', ');
  const isVoid = javaType(meta.return?.type) === 'void';

  const call = isVoid
    ? `        sol.${meta.name}(${args});
        out = H.ser(a0);`
    : `        out = H.ser(sol.${meta.name}(${args}));`;

  return `
public class Main {
  public static void main(String[] args) throws Exception {
    J tests = J.parse(H.readAll());
    PrintStream real = System.out;

    for (int ti = 0; ti < tests.a.size(); ti++) {
      J in = tests.a.get(ti).key("input");
      String out = null, err = "", log = "";
      boolean ok = true;
      double ms = 0;

${decls}

      ByteArrayOutputStream cap = new ByteArrayOutputStream();
      System.setOut(new PrintStream(cap, true, "UTF-8"));
      long t0 = System.nanoTime();
      try {
        Solution sol = new Solution();
${call}
      } catch (Throwable t) {
        ok = false;
        err = H.trace(t);
      } finally {
        ms = (System.nanoTime() - t0) / 1e6;
        System.out.flush();
        System.setOut(real);
        log = cap.toString("UTF-8");
        if (log.length() > 4000) log = log.substring(0, 4000);
      }
      H.emit(ti, ok, out, ms, err, log);
    }
  }
}
`;
}

function buildDesign(meta) {
  const ctorParams = meta.constructor?.params || [];
  const ctorDecls = ctorParams.map((p, i) =>
    `              ${javaType(p.type)} c${i} = H.${helperFor(p.type)}(cargs.at(${i}));`
  ).join('\n');
  const ctorArgs = ctorParams.map((_, i) => `c${i}`).join(', ');

  const branches = (meta.methods || []).map((m) => {
    const ps = m.params || [];
    const decls = ps.map((p, i) =>
      `              ${javaType(p.type)} m${i} = H.${helperFor(p.type)}(cargs.at(${i}));`
    ).join('\n');
    const args = ps.map((_, i) => `m${i}`).join(', ');
    const isVoid = javaType(m.return?.type) === 'void';
    const body = isVoid
      ? `              obj.${m.name}(${args});
              results.add("null");`
      : `              results.add(H.ser(obj.${m.name}(${args})));`;
    return `            if (op.equals("${m.name}")) {
${decls}
${body}
              continue;
            }`;
  }).join('\n');

  return `
public class Main {
  public static void main(String[] args) throws Exception {
    J tests = J.parse(H.readAll());
    PrintStream real = System.out;

    for (int ti = 0; ti < tests.a.size(); ti++) {
      J in = tests.a.get(ti).key("input");
      J ops = in.at(0);
      J argList = in.at(1);

      List<String> results = new ArrayList<>();
      String err = "", log = "";
      boolean ok = true;
      double ms = 0;

      ByteArrayOutputStream cap = new ByteArrayOutputStream();
      System.setOut(new PrintStream(cap, true, "UTF-8"));
      long t0 = System.nanoTime();
      try {
        ${meta.classname} obj = null;
        for (int k = 0; k < ops.a.size(); k++) {
          String op = ops.a.get(k).s;
          J cargs = argList.at(k);
          if (k == 0) {
${ctorDecls}
            obj = new ${meta.classname}(${ctorArgs});
            results.add("null");
            continue;
          }
${branches}
          results.add("null");
        }
      } catch (Throwable t) {
        ok = false;
        err = H.trace(t);
      } finally {
        ms = (System.nanoTime() - t0) / 1e6;
        System.out.flush();
        System.setOut(real);
        log = cap.toString("UTF-8");
        if (log.length() > 4000) log = log.substring(0, 4000);
      }

      H.emit(ti, ok, "[" + String.join(",", results) + "]", ms, err, log);
    }
  }
}
`;
}

const USER_BANNER = '// ---------------- user solution ----------------';

export function buildJava(meta, userCode) {
  const driver = isSystemDesign(meta) ? buildDesign(meta) : buildFunction(meta);
  // User code arrives as `class Solution {...}`; strip any public modifier so it can
  // live in Main.java alongside `public class Main`.
  const cleaned = String(userCode).replace(/^\s*public\s+class\s+/m, 'class ');
  return [
    PRELUDE,
    USER_BANNER,
    cleaned,
    '// ---------------- judge driver ----------------',
    driver,
  ].join('\n');
}

/** 1-based line in the generated Main.java where the user's code starts. */
export function javaUserOffset() {
  return [PRELUDE, USER_BANNER].join('\n').split('\n').length + 1;
}
